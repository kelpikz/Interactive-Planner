# plan-review

A Claude Code plugin for reviewing and iterating on Claude's plans with **inline
browser comments** instead of describing edits in linear chat. You highlight text
in a rendered plan, leave Google-Docs-style notes, click **Iterate**, and Claude
comes back with the next version — repeated until you're happy. When it's good,
click **Approve** to accept the plan, close the page, and shut the server down.

Built per [PLAN.md](PLAN.md) (ADR-0001).

## How it works

One long-lived Node process is both an **MCP server** (tools for Claude) and a
**local HTTP server** (the review UI):

- `publish_plan(markdown)` — renders a plan version and pushes it to the browser
  (via SSE); returns the local URL.
- `await_feedback()` — **blocks** until you click "Iterate" or "Approve", then
  returns your comments as `[{ quotedText, comment }]` plus whether you approved.

The `/plan-review` slash command drives the loop: `publish_plan` → `await_feedback`
→ revise → repeat. Clicking **Approve** (or submitting no comments) ends the loop;
Approve also closes the page and shuts the server down.

## Layout

| Path | What |
|------|------|
| `server/index.mjs` | MCP + HTTP/SSE server |
| `server/ui.html` | Review UI (rendered plan, comment popover, sidebar, Iterate, Approve) |
| `commands/plan-review.md` | The `/plan-review` slash command |
| `.claude-plugin/plugin.json` | Plugin manifest (for distribution) |
| `.mcp.json` | Registers the server for **local** use in this project |

## Use it (local dev)

1. `npm install` (already done).
2. Make sure Claude Code has loaded `.mcp.json` — the `plan-review` server should
   show as connected (reconnect via `/mcp` or restart if you just changed it).
3. Ask Claude for a plan, then run `/plan-review`.
4. A browser tab opens. Select text → leave comments → click **Iterate**.
5. Claude revises and republishes. Repeat until approved.

## Notes / v1 scope

- Single local user; state is in-memory (no persistence, auth, or hosting).
- Comments are captured as highlighted text + note with **no positional anchoring** —
  they reset on each new version. Version-aware anchoring is a later concern.
- Windows-focused browser auto-open; the URL is also returned by `publish_plan`.
