---
type: grilling
blocked_by: [03, 04]
---

# The first look

## Question

In what order does the agent look (Life's memory, then the Mac, then the user), what does it record, how long may it take, and how does it find which access is missing? How does it decide it has enough to come back to the user?

## Answer

Decided with the owner on 28 Nov 2026. The first look runs from "let me look into it" to the agent's first return to
the user, in the settled order: Life's memory, then the Mac, then the user.

- **Read-only on the user's things.** The agent may install tools from the playbook's allowlist into its own
  workspace; nothing of the user's changes before they approve a preview.
- **Missing access:** it goes as far as it can without (memory, silent permission checks, disk space, installed tools),
  then asks once for everything missing, bundled.
- **Rounds:** when access is missing, round one asks for it and round two asks the questions about what they want,
  grounded in what it then saw; when nothing is missing, one round with the questions.
- **At most one hour of work**, then it comes back with what it has; what is still unknown becomes questions.
- What it found, what is missing and what is unknown go into the project's `PLAN.md` (the playbook).
