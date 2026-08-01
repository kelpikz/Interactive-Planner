// plan-review: one long-lived process that is both an MCP server and a local
// HTTP server for the review UI.
//
// MCP tools:
//   publish_plan(markdown)                         - publish a plan version.
//   await_feedback()                               - wait for review input.
//   publish_answer(chatId, messageId, answer)      - fallback for non-Codex hosts.
//
// State is in-memory and scoped to one local review session. stdout is reserved
// for MCP JSON-RPC; all human-readable logging goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { marked } from "marked";
import { EphemeralSideChatManager } from "./codex-app-server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_HTML = readFileSync(join(__dirname, "ui.html"), "utf8");

let serverUrl = null;
let browserOpened = false;

// --- shared state -----------------------------------------------------------
const plan = { version: 0, markdown: "", html: "" };
let comments = []; // { id, quotedText, comment }
let chats = []; // { id, quotedText, planVersion, messages: ChatMessage[] }
let nextCommentId = 1;
let nextChatId = 1;
let nextMessageId = 1;

const sseClients = new Set();
const sideChats = new EphemeralSideChatManager({
  enabled:
    process.env.PLAN_REVIEW_DISABLE_EPHEMERAL !== "1" && Boolean(process.env.CODEX_THREAD_ID),
});

// await_feedback payloads are queued so browser actions are never lost while
// the agent is between tool calls.
let feedbackResolve = null;
const pendingPayloads = [];

function deliverFeedback(payload) {
  if (feedbackResolve) {
    const resolve = feedbackResolve;
    feedbackResolve = null;
    resolve(payload);
  } else {
    pendingPayloads.push(payload);
  }
}

// --- helpers ----------------------------------------------------------------
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      sseClients.delete(res);
    }
  }
}

const planEvent = () => ({ type: "plan", version: plan.version, html: plan.html });
const commentsEvent = () => ({ type: "comments", comments });
const chatsEvent = () => ({ type: "chats", chats });
const commentSnapshot = () => comments.map(({ quotedText, comment }) => ({ quotedText, comment }));

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

async function readJson(req, res) {
  try {
    return JSON.parse((await readBody(req)) || "{}");
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("invalid JSON");
    return null;
  }
}

function textField(value, maxLength = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function publishChatAnswer(chatId, messageId, answer) {
  const chat = chats.find((candidate) => candidate.id === chatId);
  const userMessage = chat?.messages.find(
    (message) => message.id === messageId && message.role === "user"
  );
  if (!chat || !userMessage) throw new Error(`Chat ${chatId}, message ${messageId} is not active`);
  if (userMessage.status !== "waiting") throw new Error(`Message ${messageId} has already finished`);

  userMessage.status = "answered";
  chat.messages.push({
    id: nextMessageId++,
    role: "assistant",
    text: answer.trim(),
    status: "complete",
    replyTo: messageId,
  });
  broadcast(chatsEvent());
}

function publishChatError(chatId, messageId, error) {
  const chat = chats.find((candidate) => candidate.id === chatId);
  const userMessage = chat?.messages.find(
    (message) => message.id === messageId && message.role === "user"
  );
  if (!chat || !userMessage || userMessage.status !== "waiting") return;
  console.error(`[plan-review] private side chat failed: ${error?.message || error}`);
  userMessage.status = "error";
  chat.messages.push({
    id: nextMessageId++,
    role: "assistant",
    text: "I couldn't start the private side chat. Restart Codex and try again.",
    status: "error",
    replyTo: messageId,
  });
  broadcast(chatsEvent());
}

async function answerInPrivateSideChat(chat, message, isFollowUp) {
  try {
    const answer = await sideChats.answer({
      chatId: chat.id,
      planMarkdown: plan.markdown,
      quotedText: chat.quotedText,
      message: message.text,
      isFollowUp,
    });
    publishChatAnswer(chat.id, message.id, answer);
  } catch (error) {
    publishChatError(chat.id, message.id, error);
  }
}

function enqueueChatMessage(chat, text) {
  const isFollowUp = chat.messages.length > 0;
  const message = {
    id: nextMessageId++,
    role: "user",
    text,
    status: "waiting",
  };
  chat.messages.push(message);
  broadcast(chatsEvent());
  if (sideChats.available) {
    void answerInPrivateSideChat(chat, message, isFollowUp);
  } else {
    // Claude Code and other hosts do not expose CODEX_THREAD_ID. Let their
    // driving agent answer through await_feedback + publish_answer instead.
    deliverFeedback({
      type: "chat_message",
      chatId: chat.id,
      messageId: message.id,
      quotedText: chat.quotedText,
      message: message.text,
      isFollowUp,
    });
  }
  return message;
}

function openBrowser(url) {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const cmdExe = process.env.ComSpec || `${systemRoot}\\System32\\cmd.exe`;
  try {
    const child = spawn(cmdExe, ["/c", "start", "", url], { detached: true, stdio: "ignore" });
    child.on("error", (error) =>
      console.error(`[plan-review] could not open browser: ${error.message}`)
    );
    child.unref();
  } catch (error) {
    console.error(`[plan-review] could not open browser: ${error.message}`);
  }
}

// --- HTTP server ------------------------------------------------------------
const httpServer = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(UI_HTML);
    return;
  }

  if (req.method === "GET" && pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("\n");
    sseClients.add(res);
    if (plan.version > 0) res.write(`data: ${JSON.stringify(planEvent())}\n\n`);
    res.write(`data: ${JSON.stringify(commentsEvent())}\n\n`);
    res.write(`data: ${JSON.stringify(chatsEvent())}\n\n`);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "POST" && pathname === "/comments") {
    const body = await readJson(req, res);
    if (body === null) return;
    const comment = textField(body.comment);
    if (comment) {
      comments.push({
        id: nextCommentId++,
        quotedText: textField(body.quotedText),
        comment,
      });
      broadcast(commentsEvent());
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // A highlighted question starts a new private, ephemeral side-chat session.
  if (req.method === "POST" && pathname === "/chats") {
    const body = await readJson(req, res);
    if (body === null) return;
    const messageText = textField(body.message);
    if (!messageText) {
      sendJson(res, 400, { error: "message is required" });
      return;
    }

    const chat = {
      id: nextChatId++,
      quotedText: textField(body.quotedText),
      planVersion: plan.version,
      messages: [],
    };
    chats.push(chat);
    const message = enqueueChatMessage(chat, messageText);
    sendJson(res, 200, { chatId: chat.id, messageId: message.id });
    return;
  }

  // Follow-up messages are appended to the same browser chat and routed to its
  // existing in-memory Codex thread.
  const chatMessageMatch = pathname.match(/^\/chats\/(\d+)\/messages$/);
  if (req.method === "POST" && chatMessageMatch) {
    const body = await readJson(req, res);
    if (body === null) return;
    const chatId = Number(chatMessageMatch[1]);
    const chat = chats.find((candidate) => candidate.id === chatId);
    if (!chat) {
      sendJson(res, 404, { error: "chat not found" });
      return;
    }
    if (chat.messages.some((message) => message.status === "waiting")) {
      sendJson(res, 409, { error: "wait for the current answer before sending a follow-up" });
      return;
    }
    const messageText = textField(body.message);
    if (!messageText) {
      sendJson(res, 400, { error: "message is required" });
      return;
    }
    const message = enqueueChatMessage(chat, messageText);
    sendJson(res, 200, { chatId: chat.id, messageId: message.id });
    return;
  }

  if (req.method === "DELETE" && pathname.startsWith("/comments/")) {
    const id = Number(pathname.split("/").pop());
    comments = comments.filter((comment) => comment.id !== id);
    broadcast(commentsEvent());
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/iterate") {
    deliverFeedback({ type: "feedback", comments: commentSnapshot(), approved: false });
    comments = [];
    broadcast(commentsEvent());
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/approve") {
    deliverFeedback({ type: "feedback", comments: commentSnapshot(), approved: true });
    comments = [];
    broadcast({ type: "closed" });
    sendJson(res, 200, { ok: true });
    setTimeout(() => shutdown("approved by user"), 750);
    return;
  }

  res.writeHead(404);
  res.end();
});

httpServer.on("error", (error) =>
  console.error(`[plan-review] HTTP server error (not fatal to MCP): ${error.code || error.message}`)
);

// --- MCP server -------------------------------------------------------------
const server = new McpServer({ name: "plan-review", version: "0.1.0" });

server.registerTool(
  "publish_plan",
  {
    title: "Publish plan for review",
    description:
      "Render a plan in the local review UI. Call this once per plan version, then call " +
      "await_feedback. Republishing advances the version and starts fresh comments and side chats.",
    inputSchema: { markdown: z.string().describe("The complete plan as Markdown.") },
  },
  async ({ markdown }) => {
    plan.version += 1;
    plan.markdown = markdown;
    plan.html = marked.parse(markdown);
    comments = [];
    await sideChats.reset();
    chats = [];
    nextChatId = 1;
    nextMessageId = 1;
    pendingPayloads.length = 0;
    broadcast(planEvent());
    broadcast(commentsEvent());
    broadcast(chatsEvent());
    if (!browserOpened && process.env.PLAN_REVIEW_NO_BROWSER !== "1") {
      openBrowser(serverUrl);
      browserOpened = true;
    }
    return {
      content: [
        {
          type: "text",
          text:
            `Published plan v${plan.version} at ${serverUrl}\n` +
            "Call await_feedback now. It returns comments or approval; private side chats answer automatically.",
        },
      ],
    };
  }
);

server.registerTool(
  "publish_answer",
  {
    title: "Publish a side-chat answer",
    description:
      "Fallback for hosts without Codex ephemeral threads: append the host agent's real answer " +
      "to the matching browser chat message. Codex side chats answer automatically.",
    inputSchema: {
      chatId: z.number().int().positive().describe("The chatId returned by await_feedback."),
      messageId: z.number().int().positive().describe("The messageId returned by await_feedback."),
      answer: z.string().min(1).describe("The host agent's direct answer, without plumbing commentary."),
    },
  },
  async ({ chatId, messageId, answer }) => {
    try {
      publishChatAnswer(chatId, messageId, answer);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Published the answer for chat ${chatId}, message ${messageId}. Call await_feedback again.`,
        },
      ],
    };
  }
);

server.registerTool(
  "await_feedback",
  {
    title: "Await review feedback",
    description:
      "BLOCKS until the user submits review feedback or approves. In Codex, browser side-chat " +
      "messages are handled automatically by private ephemeral threads and do not wake this tool. " +
      "Other hosts may receive a chat_message fallback to answer with publish_answer.",
    inputSchema: {},
  },
  async (_args, extra) => {
    let payload;
    if (pendingPayloads.length) {
      payload = pendingPayloads.shift();
    } else {
      payload = await new Promise((resolve, reject) => {
        feedbackResolve = resolve;
        const signal = extra?.signal;
        if (signal) {
          if (signal.aborted) {
            feedbackResolve = null;
            return reject(new Error("cancelled before waiting"));
          }
          signal.addEventListener(
            "abort",
            () => {
              feedbackResolve = null;
              console.error("[plan-review] await_feedback cancelled by client");
              reject(new Error("cancelled by client"));
            },
            { once: true }
          );
        }
      });
    }

    if (payload.type === "chat_message") {
      const event = {
        type: payload.type,
        planVersion: plan.version,
        chatId: payload.chatId,
        messageId: payload.messageId,
        isFollowUp: payload.isFollowUp,
        quotedText: payload.quotedText,
        message: payload.message,
        planMarkdown: plan.markdown,
      };
      return {
        content: [
          {
            type: "text",
            text:
              `${JSON.stringify(event, null, 2)}\n\n` +
              "Answer the actual question directly in this host task, publish the genuine answer " +
              "with publish_answer, then call await_feedback again. Never create a side task or " +
              "publish sample text.",
          },
        ],
      };
    }

    const { comments: feedback, approved } = payload;
    let text;
    if (approved) {
      text =
        `User approved plan v${plan.version}. The review is complete and the server is shutting down` +
        (feedback.length
          ? `. They also left ${feedback.length} comment(s):\n\n${JSON.stringify(feedback, null, 2)}`
          : " with no further changes requested.");
    } else if (feedback.length) {
      text =
        `User submitted ${feedback.length} comment(s) on plan v${plan.version}:\n\n` +
        JSON.stringify(feedback, null, 2);
    } else {
      text =
        `User clicked Iterate on plan v${plan.version} with no comments. ` +
        "The review remains active; call await_feedback again.";
    }
    return { content: [{ type: "text", text }] };
  }
);

// --- startup ----------------------------------------------------------------
await new Promise((resolve) => {
  httpServer.listen(0, "127.0.0.1", () => {
    serverUrl = `http://localhost:${httpServer.address().port}`;
    console.error(`[plan-review] review UI at ${serverUrl}`);
    resolve();
  });
});

const transport = new StdioServerTransport();

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[plan-review] shutting down (${reason})`);
  sideChats.close();
  for (const res of sseClients) {
    try {
      res.end();
    } catch {}
  }
  try {
    httpServer.close();
  } catch {}
  process.exit(0);
}

server.server.onclose = () => shutdown("client disconnected");
process.stdin.on("close", () => shutdown("stdin closed"));
process.stdin.on("end", () => shutdown("stdin ended"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

await server.connect(transport);
console.error("[plan-review] MCP server connected on stdio");
