import assert from "node:assert/strict";
import { CodexAppServerClient } from "../server/codex-app-server.mjs";

const client = new CodexAppServerClient();

try {
  const threadId = await client.startEphemeral();
  assert.ok(threadId);

  const first = await client.runTurn(
    threadId,
    "This is an integration check. Reply with only the text PRIVATE_CHAT_OK. Do not use tools."
  );
  assert.match(first, /PRIVATE_CHAT_OK/);

  const followUp = await client.runTurn(
    threadId,
    "Now reply with only FOLLOW_UP_OK to confirm this is the same conversation."
  );
  assert.match(followUp, /FOLLOW_UP_OK/);

  const listed = await client.request("thread/list", { limit: 100 });
  const storedIds = (listed?.data || []).map((thread) => thread.id);
  assert.equal(
    storedIds.includes(threadId),
    false,
    "the ephemeral side-chat thread must not appear in stored task listings"
  );

  console.log(`EPHEMERAL_APP_SERVER_SMOKE_PASS ${threadId}`);
} finally {
  client.close();
}
