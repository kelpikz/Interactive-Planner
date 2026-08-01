# plan-review

A Claude Code and Codex plugin for reviewing AI-generated plans with inline
browser comments and private side chats. Highlight plan text to request an
edit or ask a question, iterate until the plan is ready, then approve it.

The plugin uses one long-lived Node process as both an MCP server and a local
HTTP server for the browser UI.

## How it works

- `publish_plan(markdown)` renders a plan version and pushes it to the browser.
- `await_feedback()` blocks until the browser submits comments or approval.
- In Codex, each new browser conversation gets a private ephemeral App Server
  thread. Follow-ups reuse it, but it is not persisted or shown in the task list.
- `publish_answer(chatId, messageId, answer)` is a compatibility fallback for
  hosts that cannot create Codex ephemeral threads.

Only an explicit **Approve** action ends the review. Approval also closes the UI
and shuts down the local server.

## Layout

| Path | What |
|------|------|
| `server/index.mjs` | MCP and HTTP/SSE server source |
| `server/codex-app-server.mjs` | Private ephemeral Codex side-chat client |
| `server/bundle.mjs` | Self-contained build used by the installed plugin |
| `server/ui.html` | Plan, comments, private side-chat transcript, and review controls |
| `commands/plan-review.md` | Claude Code slash-command workflow |
| `skills/plan-review/SKILL.md` | Codex plan-review and private-chat workflow |
| `.claude-plugin/plugin.json` | Claude Code plugin manifest |
| `.claude-plugin/marketplace.json` | Marketplace manifest |
| `.codex-plugin/plugin.json` | Codex plugin manifest |
| `.mcp.json` | Codex MCP server configuration |

## Install

### Claude Code

```text
/plugin marketplace add ajithprasad004/plan-review
/plugin install plan-review
```

### Codex

Add this repository as a local marketplace, then install `plan-review`. The
plugin ships with a bundled server and does not need `npm install` at runtime.

## Use it

1. Ask for a plan, then ask Codex to use `plan-review` (or run `/plan-review` in
   Claude Code).
2. In the browser, highlight text and choose **Comment** to request a change, or
   **Ask question** to start a side chat about that passage.
3. The answer appears in a ChatGPT-style transcript. Use the composer below it
   for follow-ups; they continue in the same private in-memory conversation.
4. Submit comments with **Iterate** to revise and republish the plan. Repeat until
   you click **Approve**.

## Development

`server/index.mjs` is the source and `server/bundle.mjs` is the committed build.
After editing the source, rebuild it:

```text
npm install
npm run build
```

## Current scope

- Single local user; state is in-memory with no persistence, authentication, or hosting.
- Comments use highlighted text plus a note and have no positional anchoring.
- Comments and ephemeral side chats reset when a revised plan version is published.
- Browser auto-open is Windows-focused; `publish_plan` also returns the local URL.
