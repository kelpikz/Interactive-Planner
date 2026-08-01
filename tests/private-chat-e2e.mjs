import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

assert.ok(process.env.CODEX_THREAD_ID, "run this test from a Codex task");

const client = new Client({ name: "plan-review-private-chat-e2e", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server/bundle.mjs"],
  cwd: process.cwd(),
  env: { ...process.env, PLAN_REVIEW_NO_BROWSER: "1" },
  stderr: "inherit",
});

function textOf(result) {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

async function waitForChat(url, predicate, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("event stream ended before the expected chat answer");
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (!data) continue;
        const event = JSON.parse(data);
        const match = predicate(event);
        if (match) return match;
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

await client.connect(transport);

try {
  const published = await client.callTool({
    name: "publish_plan",
    arguments: { markdown: "# Rollout\n\nRelease to 10% of users before expanding." },
  });
  const url = textOf(published).match(/https?:\/\/localhost:\d+/)?.[0];
  assert.ok(url);

  let reviewFinished = false;
  const review = client
    .callTool({ name: "await_feedback", arguments: {} }, undefined, { timeout: 180_000 })
    .then((result) => {
      reviewFinished = true;
      return result;
    });

  const firstAnswer = waitForChat(url, (event) => {
    if (event.type !== "chats") return null;
    const chat = event.chats[0];
    return chat?.messages.some((message) => message.role === "assistant") ? chat : null;
  });
  const firstPost = await fetch(`${url}/chats`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quotedText: "Release to 10% of users before expanding.",
      message: "Why start at ten percent? Answer in one sentence.",
    }),
  });
  assert.equal(firstPost.status, 200);
  const { chatId } = await firstPost.json();
  const firstChat = await firstAnswer;
  assert.equal(firstChat.id, chatId);
  assert.equal(reviewFinished, false, "a side-chat answer must not wake await_feedback");

  const secondAnswer = waitForChat(url, (event) => {
    if (event.type !== "chats") return null;
    const chat = event.chats.find((candidate) => candidate.id === chatId);
    const assistants = chat?.messages.filter((message) => message.role === "assistant") || [];
    return assistants.length === 2 ? chat : null;
  });
  const followUpPost = await fetch(`${url}/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "What should trigger expansion? Answer in one sentence." }),
  });
  assert.equal(followUpPost.status, 200);
  const completedChat = await secondAnswer;
  assert.equal(completedChat.messages.filter((message) => message.role === "assistant").length, 2);
  assert.equal(reviewFinished, false, "follow-ups must also stay inside the private chat");

  await fetch(`${url}/approve`, { method: "POST" });
  assert.match(textOf(await review), /approved plan/i);
  console.log("PRIVATE_CHAT_E2E_PASS");
} finally {
  await transport.close();
}
