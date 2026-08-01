---
description: Review a plan in a browser with inline comments and private side chats
allowed-tools:
  - mcp__plan-review__publish_plan
  - mcp__plan-review__await_feedback
  - mcp__plan-review__publish_answer
---

Run the interactive plan-review loop for the most recent plan or proposal.

1. Publish the complete plan Markdown with `publish_plan`, then call `await_feedback`.
2. On comment feedback, revise every quoted passage, republish the complete plan, and await feedback again.
3. While `await_feedback` is blocked, the plugin automatically answers browser questions in private, in-memory Codex threads. Do not fork or manage tasks for them.
4. If `await_feedback` returns a `chat_message` fallback, answer the actual question directly in this task, publish the genuine answer with `publish_answer`, and await feedback again. Never publish canned, placeholder, sample, test, or workflow-description text.
5. Stop only on explicit approval or when the user asks to stop. Iterate with no comments is not approval.

Keep main-chat updates brief because the browser remains the source of truth.
