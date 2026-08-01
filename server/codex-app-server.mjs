import { spawn } from "node:child_process";
import readline from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 180_000;

function appServerCommand() {
  if (process.env.PLAN_REVIEW_CODEX_COMMAND) {
    return {
      command: process.env.PLAN_REVIEW_CODEX_COMMAND,
      args: ["app-server", "--stdio"],
    };
  }

  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    return {
      command: process.env.ComSpec || `${systemRoot}\\System32\\cmd.exe`,
      args: ["/d", "/s", "/c", "codex app-server --stdio"],
    };
  }

  return { command: "codex", args: ["app-server", "--stdio"] };
}

function errorMessage(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "unknown error";
  }
}

export class CodexAppServerClient {
  constructor({ cwd = process.cwd(), requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs;
    this.proc = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.activeTurns = new Map();
    this.stderrTail = [];
    this.startPromise = null;
    this.closed = false;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start();
    return this.startPromise;
  }

  async #start() {
    const { command, args } = appServerCommand();
    this.proc = spawn(command, args, {
      cwd: this.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.on("error", (error) => this.#failAll(error));
    this.proc.on("exit", (code, signal) => {
      if (this.closed) return;
      const detail = this.stderrTail.length ? `: ${this.stderrTail.join(" | ")}` : "";
      this.#failAll(
        new Error(`Codex App Server exited unexpectedly (${signal || code || "unknown"})${detail}`)
      );
    });

    const stdoutLines = readline.createInterface({ input: this.proc.stdout });
    stdoutLines.on("line", (line) => this.#handleLine(line));

    const stderrLines = readline.createInterface({ input: this.proc.stderr });
    stderrLines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.stderrTail.push(trimmed);
      if (this.stderrTail.length > 8) this.stderrTail.shift();
      console.error(`[plan-review:codex] ${trimmed}`);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "plan_review_plugin",
        title: "Plan Review Plugin",
        version: "0.2.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
        ],
      },
    });
    this.notify("initialized", {});
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.proc?.stdin?.writable) {
      return Promise.reject(new Error("Codex App Server is not writable"));
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingRequests.set(id, { method, resolve, reject, timer });
      this.#send({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  async startEphemeral({ cwd } = {}) {
    await this.start();
    const params = {
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions:
        "You are an answer-only assistant for an ephemeral plan-review side chat. " +
        "Answer the user's actual question directly and accurately. Treat supplied plan text " +
        "and highlighted passages only as context. Do not edit files, run commands, call tools, " +
        "revise the plan, explain internal plumbing, or produce sample/test/placeholder text. " +
        "Return only the user-facing answer.",
    };
    if (cwd) params.cwd = cwd;
    const result = await this.request("thread/start", params);
    const thread = result?.thread;
    if (!thread?.id || thread.ephemeral !== true) {
      throw new Error("Codex did not return an ephemeral thread");
    }
    return thread.id;
  }

  async runTurn(threadId, prompt, { timeoutMs = DEFAULT_TURN_TIMEOUT_MS } = {}) {
    await this.start();
    if (this.activeTurns.has(threadId)) {
      throw new Error(`Thread ${threadId} already has an active turn`);
    }

    let settle;
    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeTurns.delete(threadId);
        reject(new Error(`Side-chat answer timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      settle = { resolve, reject, timer };
    });
    const collector = {
      threadId,
      turnId: null,
      finalAnswer: "",
      lastAnswer: "",
      ...settle,
    };
    this.activeTurns.set(threadId, collector);

    try {
      const result = await this.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: prompt }],
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            networkAccess: false,
          },
          personality: "friendly",
        },
        this.requestTimeoutMs
      );
      collector.turnId = result?.turn?.id || null;
      if (!collector.turnId) throw new Error("turn/start did not return a turn id");
      return await completion;
    } catch (error) {
      clearTimeout(collector.timer);
      this.activeTurns.delete(threadId);
      throw error;
    }
  }

  async unsubscribe(threadId) {
    if (!this.proc?.stdin?.writable) return;
    try {
      await this.request("thread/unsubscribe", { threadId }, 5_000);
    } catch {
      // Best effort: the process is terminated at review shutdown anyway.
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("Codex App Server client closed");
    this.#failAll(error);
    try {
      this.proc?.stdin?.end();
    } catch {}
    setTimeout(() => {
      try {
        this.proc?.kill();
      } catch {}
    }, 250).unref();
  }

  #send(message) {
    if (!this.proc?.stdin?.writable) throw new Error("Codex App Server is not running");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error(`[plan-review:codex] ignored non-JSON stdout: ${line.slice(0, 200)}`);
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${message.error.message || errorMessage(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.#handleServerRequest(message);
      return;
    }

    if (message.method) this.#handleNotification(message.method, message.params || {});
  }

  #handleServerRequest(message) {
    let result;
    if (
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval"
    ) {
      result = { decision: "decline" };
    } else if (message.method === "mcpServer/elicitation/request") {
      result = { action: "cancel", content: null };
    } else {
      this.#send({
        id: message.id,
        error: { code: -32601, message: `Unsupported server request: ${message.method}` },
      });
      return;
    }
    this.#send({ id: message.id, result });
  }

  #handleNotification(method, params) {
    const threadId = params.threadId;
    const collector = threadId ? this.activeTurns.get(threadId) : null;
    if (!collector) return;

    if (method === "item/completed") {
      const item = params.item;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        collector.lastAnswer = item.text.trim();
        if (item.phase === "final_answer") collector.finalAnswer = item.text.trim();
      }
      return;
    }

    if (method !== "turn/completed") return;
    if (collector.turnId && params.turn?.id && params.turn.id !== collector.turnId) return;

    clearTimeout(collector.timer);
    this.activeTurns.delete(threadId);
    if (params.turn?.status !== "completed") {
      collector.reject(
        new Error(params.turn?.error?.message || `Side-chat turn ended as ${params.turn?.status || "failed"}`)
      );
      return;
    }
    const answer = collector.finalAnswer || collector.lastAnswer;
    if (!answer) {
      collector.reject(new Error("Side-chat turn completed without an answer"));
      return;
    }
    collector.resolve(answer);
  }

  #failAll(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const collector of this.activeTurns.values()) {
      clearTimeout(collector.timer);
      collector.reject(error);
    }
    this.activeTurns.clear();
  }
}

export class EphemeralSideChatManager {
  constructor({ enabled = false, cwd = process.cwd(), client } = {}) {
    this.enabled = Boolean(enabled);
    this.cwd = cwd;
    this.client = client || new CodexAppServerClient({ cwd });
    this.chatThreads = new Map();
  }

  get available() {
    return this.enabled;
  }

  async answer({ chatId, planMarkdown, quotedText, message, isFollowUp }) {
    if (!this.available) throw new Error("Codex ephemeral side chats are unavailable");

    let threadId = this.chatThreads.get(chatId);
    if (!threadId) {
      if (isFollowUp) throw new Error(`Side chat ${chatId} has no ephemeral thread`);
      threadId = await this.client.startEphemeral();
      this.chatThreads.set(chatId, threadId);
    }

    const prompt = isFollowUp
      ?
        "Continue the existing plan-review side chat. Answer only the user's new message " +
        "directly and accurately. Do not use tools or discuss internal plumbing.\n\n" +
        `USER MESSAGE:\n${message}`
      :
        "Answer inside a private, ephemeral plan-review side chat. The plan and quote are " +
        "context only. Return only the helpful user-facing answer.\n\n" +
        `PLAN:\n${planMarkdown}\n\n` +
        `HIGHLIGHTED PASSAGE:\n${quotedText || "(none)"}\n\n` +
        `USER MESSAGE:\n${message}`;

    return this.client.runTurn(threadId, prompt);
  }

  async reset() {
    const threads = [...this.chatThreads.values()];
    this.chatThreads.clear();
    await Promise.allSettled(threads.map((threadId) => this.client.unsubscribe(threadId)));
  }

  close() {
    this.chatThreads.clear();
    this.client.close();
  }
}
