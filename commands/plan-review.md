---
description: Review the current plan in the browser with inline comments, and iterate until approved.
---

You are running the **plan-review** loop. The user wants to review a plan you've
produced by leaving inline comments in a browser, instead of describing edits in chat.

Do this:

1. Identify the plan to review — the most recent plan, design, or proposal you produced
   in this conversation. If there isn't a clear one yet, ask the user what to review (or
   draft a first version), then continue.
2. Call the `publish_plan` MCP tool with the full plan as **markdown**. This opens/updates
   the review page in the browser and returns a local URL.
3. Call the `await_feedback` MCP tool. It **blocks** until the user clicks "Iterate" in the
   browser, then returns their inline comments as a list of `{ quotedText, comment }`.
4. Revise the plan so it honors every comment — apply each note to the passage it quotes.
5. Call `publish_plan` again with the revised markdown, then `await_feedback` again. Repeat.
6. Stop when `await_feedback` returns **no comments** (treat as approval — confirm the plan is
   agreed and end the loop), or when the user tells you in chat to stop.

Keep chat messages between rounds short: the browser is the source of truth, so don't paste
the whole plan into chat each round. A one-line summary of what changed is enough.
