---
name: plan-review
description: Review and iterate on a plan using inline comments and private ephemeral side chats in a local browser. Use when the user asks to review a plan visually, annotate a plan, ask questions about selected plan text, use inline comments, or explicitly asks for plan-review.
---

# Plan Review

Run an interactive browser review loop for the most recent plan, design, or proposal.

1. Identify the content to review. If there is no clear plan, ask what to review or draft a first version.
2. Call `publish_plan` with the complete plan as Markdown. Give the returned local URL to the user if the page does not open automatically.
3. Call `await_feedback`. It waits for **Iterate** or **Approve**. In Codex, the plugin answers highlighted questions and follow-ups automatically in private ephemeral side chats while this call remains blocked.
4. For Iterate feedback, revise every quoted passage according to its comment, publish the complete revised plan, and await feedback again. Iterate with no comments is not approval; await feedback again.
5. Do not create, fork, or manage Codex tasks for browser questions. The plugin owns the private side-chat lifecycle.

## Private side chats

For each new browser conversation, the plugin starts a clean ephemeral Codex App Server thread seeded with the plan, highlighted passage, and question. The thread is held only in memory, is omitted from stored task listings, and is not shown in the Codex sidebar. Follow-up questions reuse that same ephemeral thread so conversational context is preserved.

Side-chat messages do not revise the plan, advance its version, or wake `await_feedback`. Republishing a revised plan clears its side chats. Approval shuts down the review server and discards all ephemeral chat state.

If `await_feedback` returns a `chat_message`, the host does not support Codex ephemeral threads. In that fallback only:

1. Answer the actual question directly in the current host task using the supplied plan and quote as context.
2. Call `publish_answer(chatId, messageId, answer)` with the genuine user-facing answer. Never publish sample, placeholder, test, or workflow-description text.
3. Call `await_feedback` again. Never create a side task for this fallback.

## Completion

Stop only when `await_feedback` says the user explicitly approved, or when the user asks to stop. Keep chat updates between rounds to one short summary. The browser is the source of truth, so do not paste the full plan into the main chat.
