import assert from "node:assert/strict";
import { EphemeralSideChatManager } from "../server/codex-app-server.mjs";

class FakeAppServerClient {
  constructor() {
    this.forks = [];
    this.turns = [];
    this.unsubscribed = [];
    this.closed = false;
  }

  async startEphemeral() {
    this.forks.push(true);
    return `ephemeral-${this.forks.length}`;
  }

  async runTurn(threadId, prompt) {
    this.turns.push({ threadId, prompt });
    return `answer-${this.turns.length}`;
  }

  async unsubscribe(threadId) {
    this.unsubscribed.push(threadId);
  }

  close() {
    this.closed = true;
  }
}

const client = new FakeAppServerClient();
const manager = new EphemeralSideChatManager({
  enabled: true,
  client,
});

assert.equal(manager.available, true);
assert.equal(
  await manager.answer({
    chatId: 7,
    planMarkdown: "# Plan\n\nRelease gradually.",
    quotedText: "Release gradually.",
    message: "Why?",
    isFollowUp: false,
  }),
  "answer-1"
);
assert.equal(
  await manager.answer({
    chatId: 7,
    message: "What should we measure?",
    isFollowUp: true,
  }),
  "answer-2"
);

assert.deepEqual(client.forks, [true], "one browser chat should start exactly one private thread");
assert.deepEqual(
  client.turns.map(({ threadId }) => threadId),
  ["ephemeral-1", "ephemeral-1"],
  "follow-ups should reuse the same ephemeral thread"
);
assert.match(client.turns[0].prompt, /Release gradually/);
assert.match(client.turns[0].prompt, /Why\?/);
assert.match(client.turns[1].prompt, /What should we measure\?/);

await manager.reset();
assert.deepEqual(client.unsubscribed, ["ephemeral-1"]);
manager.close();
assert.equal(client.closed, true);

console.log("EPHEMERAL_SIDE_CHAT_UNIT_PASS");
