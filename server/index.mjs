// plan-review: a Claude Code plugin spine — one long-lived process that is both
// an MCP server (tools for Claude) and a local HTTP server (the review UI).
//
// MCP tools:
//   publish_plan(markdown) — render a plan version, push it to the browser, return the URL.
//   await_feedback()       — BLOCK until the user clicks "Iterate", return [{quotedText, comment}].
//
// State is in-memory (single local user). Comments are captured as highlighted
// string + note with no positional anchoring — stale comments across versions
// are acceptable for v1 (ADR-0001).
//
// NOTE: stdout is reserved for MCP JSON-RPC. All human logging goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { marked } from "marked";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_HTML = readFileSync(join(__dirname, "ui.html"), "utf8");

// Bound after the HTTP server starts on a random free port (see spike ADR:
// a fixed port collides with a stale instance and crashes the process).
let serverUrl = null;
let browserOpened = false;

// --- shared state -----------------------------------------------------------
const plan = { version: 0, markdown: "", html: "" };
let comments = []; // { id, quotedText, comment }
let nextCommentId = 1;

const sseClients = new Set();

// await_feedback plumbing. If the user clicks Iterate/Approve before Claude has
// armed await_feedback, we stash the payload and hand it over on the next call.
// Payload shape: { comments: [{quotedText, comment}], approved: boolean }.
let feedbackResolve = null;
let pendingSnapshot = null;

// Hand a feedback payload to a waiting await_feedback, or stash it if Claude is
// not yet blocking on one.
function deliverFeedback(payload) {
  if (feedbackResolve) {
    const resolve = feedbackResolve;
    feedbackResolve = null;
    resolve(payload);
  } else {
    pendingSnapshot = payload;
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

// Feedback returned to Claude strips internal ids.
const snapshot = () => comments.map(({ quotedText, comment }) => ({ quotedText, comment }));

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

function openBrowser(url) {
  // MCP clients spawn servers with a FILTERED env that drops ComSpec but keeps
  // SystemRoot, so derive an absolute cmd.exe path. The 'error' listener is
  // load-bearing: a spawn failure is emitted asynchronously (a try/catch can't
  // catch it) and an unhandled 'error' event would crash the whole server.
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const cmdExe = process.env.ComSpec || `${systemRoot}\\System32\\cmd.exe`;
  try {
    const child = spawn(cmdExe, ["/c", "start", "", url], { detached: true, stdio: "ignore" });
    child.on("error", (e) => console.error(`[plan-review] could not open browser: ${e.message}`));
    child.unref();
  } catch (e) {
    console.error(`[plan-review] could not open browser: ${e.message}`);
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
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "POST" && pathname === "/comments") {
    const { quotedText, comment } = JSON.parse((await readBody(req)) || "{}");
    if (comment && comment.trim()) {
      comments.push({ id: nextCommentId++, quotedText: quotedText || "", comment: comment.trim() });
      broadcast(commentsEvent());
    }
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (req.method === "DELETE" && pathname.startsWith("/comments/")) {
    const id = Number(pathname.split("/").pop());
    comments = comments.filter((c) => c.id !== id);
    broadcast(commentsEvent());
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (req.method === "POST" && pathname === "/iterate") {
    deliverFeedback({ comments: snapshot(), approved: false });
    comments = [];
    broadcast(commentsEvent());
    res.writeHead(200);
    res.end("ok");
    return;
  }

  // Approve is the terminal action: accept the current plan, tell the browser to
  // close, and shut the whole process down. Any comments left unsent are included
  // so Claude still sees them. Shutdown is deferred so the await_feedback tool
  // response flushes over stdio before process.exit.
  if (req.method === "POST" && pathname === "/approve") {
    deliverFeedback({ comments: snapshot(), approved: true });
    comments = [];
    broadcast({ type: "closed" });
    res.writeHead(200);
    res.end("ok");
    setTimeout(() => shutdown("approved by user"), 750);
    return;
  }

  res.writeHead(404);
  res.end();
});

httpServer.on("error", (e) =>
  console.error(`[plan-review] HTTP server error (not fatal to MCP): ${e.code || e.message}`)
);

// --- MCP server -------------------------------------------------------------
const server = new McpServer({ name: "plan-review", version: "0.1.0" });

server.registerTool(
  "publish_plan",
  {
    title: "Publish plan for review",
    description:
      "Render a plan (markdown) in the local review UI and push it to the browser. " +
      "Returns the local URL. Call this, then await_feedback. Calling it again with a " +
      "revised plan advances to the next version and clears prior comments.",
    inputSchema: { markdown: z.string().describe("The full plan, as markdown.") },
  },
  async ({ markdown }) => {
    plan.version += 1;
    plan.markdown = markdown;
    plan.html = marked.parse(markdown);
    comments = []; // new version: reset comments (stale acceptable per ADR-0001)
    broadcast(planEvent());
    broadcast(commentsEvent());
    if (!browserOpened) {
      openBrowser(serverUrl);
      browserOpened = true;
    }
    return {
      content: [
        {
          type: "text",
          text: `Published plan v${plan.version} at ${serverUrl}\nNow call await_feedback to block until the user submits their inline comments.`,
        },
      ],
    };
  }
);

server.registerTool(
  "await_feedback",
  {
    title: "Await user feedback",
    description:
      "BLOCKS until the user clicks 'Iterate' in the review UI, then returns their inline " +
      "comments as [{quotedText, comment}]. Incorporate every comment, then call publish_plan " +
      "with the revised plan to continue the loop. An empty result means the user approved.",
    inputSchema: {},
  },
  async (_args, extra) => {
    let payload;
    if (pendingSnapshot) {
      payload = pendingSnapshot;
      pendingSnapshot = null;
    } else {
      payload = await new Promise((resolve, reject) => {
        feedbackResolve = resolve;
        const signal = extra?.signal;
        if (signal) {
          if (signal.aborted) {
            feedbackResolve = null;
            return reject(new Error("cancelled before waiting"));
          }
          signal.addEventListener("abort", () => {
            feedbackResolve = null;
            console.error("[plan-review] await_feedback cancelled by client");
            reject(new Error("cancelled by client"));
          });
        }
      });
    }

    const { comments: feedback, approved } = payload;
    let text;
    if (approved) {
      text =
        `User approved plan v${plan.version} and closed the review UI. The review is ` +
        `complete and the server is shutting down` +
        (feedback.length
          ? `. They also left ${feedback.length} comment(s):\n\n` + JSON.stringify(feedback, null, 2)
          : ` with no further changes requested.`);
    } else if (feedback.length) {
      text =
        `User submitted ${feedback.length} comment(s) on plan v${plan.version}:\n\n` +
        JSON.stringify(feedback, null, 2);
    } else {
      text = `User clicked Iterate on plan v${plan.version} with no comments — treat as approval / no changes requested.`;
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

// A stdio MCP server must exit when its client disconnects. The HTTP server and
// any open SSE connection keep Node's event loop alive, so without this the
// process orphans (holding its port) after Claude Code goes away.
let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[plan-review] shutting down (${reason})`);
  for (const res of sseClients) {
    try { res.end(); } catch {}
  }
  try { httpServer.close(); } catch {}
  process.exit(0);
}

// Fires when the client closes the stdio transport (the normal disconnect path).
server.server.onclose = () => shutdown("client disconnected");
// Backstops: parent death closes our stdin; terminal/OS signals.
process.stdin.on("close", () => shutdown("stdin closed"));
process.stdin.on("end", () => shutdown("stdin ended"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

await server.connect(transport);
console.error("[plan-review] MCP server connected on stdio");
