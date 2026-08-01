import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "plan-review-chat-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server/bundle.mjs"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    PLAN_REVIEW_NO_BROWSER: "1",
    PLAN_REVIEW_DISABLE_EPHEMERAL: "1",
  },
  stderr: "inherit",
});

function textOf(result) {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

function eventOf(result) {
  return JSON.parse(textOf(result).split("\n\n", 1)[0]);
}

await client.connect(transport);

const published = await client.callTool({
  name: "publish_plan",
  arguments: {
    markdown: "# Release plan\n\nShip behind a feature flag, then expand gradually.",
  },
});
const url = textOf(published).match(/https?:\/\/localhost:\d+/)?.[0];
assert.ok(url, "publish_plan should return the review URL");

const firstWait = client.callTool(
  { name: "await_feedback", arguments: {} },
  undefined,
  { timeout: 10_000 }
);
const firstResponse = await fetch(`${url}/chats`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    quotedText: "Ship behind a feature flag",
    message: "Why is a feature flag useful here?",
  }),
});
assert.equal(firstResponse.status, 200);
const first = eventOf(await firstWait);
assert.equal(first.type, "chat_message");
assert.equal(first.isFollowUp, false);

const firstAnswer = await client.callTool({
  name: "publish_answer",
  arguments: {
    chatId: first.chatId,
    messageId: first.messageId,
    answer: "It limits exposure while the rollout is being validated.",
  },
});
assert.match(textOf(firstAnswer), /Published the answer/);

const secondWait = client.callTool(
  { name: "await_feedback", arguments: {} },
  undefined,
  { timeout: 10_000 }
);
const secondResponse = await fetch(`${url}/chats/${first.chatId}/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "What metric should trigger expansion?" }),
});
assert.equal(secondResponse.status, 200);
const second = eventOf(await secondWait);
assert.equal(second.chatId, first.chatId);
assert.equal(second.isFollowUp, true);

const secondAnswer = await client.callTool({
  name: "publish_answer",
  arguments: {
    chatId: second.chatId,
    messageId: second.messageId,
    answer: "Expand after error rate and support volume remain within the agreed guardrails.",
  },
});
assert.match(textOf(secondAnswer), /Published the answer/);

const duplicate = await client.callTool({
  name: "publish_answer",
  arguments: {
    chatId: second.chatId,
    messageId: second.messageId,
    answer: "This must be rejected.",
  },
});
assert.equal(duplicate.isError, true);

const html = await (await fetch(url)).text();
assert.match(html, /Ask a follow-up/);
assert.match(html, /chat-messages/);
assert.doesNotMatch(html, /Sample answer/);

if (process.env.PLAN_REVIEW_PREVIEW === "1") {
  console.log(`PREVIEW_URL ${url}`);
  await new Promise(() => {});
}

await fetch(`${url}/approve`, { method: "POST" });
await transport.close();
console.log("MULTI_TURN_CHAT_SMOKE_PASS");
