---
type: grilling
blocked_by: []
---

# The engineering playbook

## Question

Life's own variant of the owner's `work-on-code` skill, for project agents on the agent's model (today DeepSeek Flash):
which parts of `work-on-code` carry over, which go, and how each kept rule becomes a step the agent can't skip. Set by the
owner, never by the model. Frame he set on 27 Nov 2026:

- Quality means the output: how good it looks and feels to use (covered by the preview), and that it works with no
  bugs, or that any bug is surfaced to the user plainly. Technical debt and multi-provider tiering are stripped out:
  mini projects stay minimal and functional.
- One fixed stack: Bun and TypeScript. Anything else only on the owner's yes.
- Reviews are independent (a fresh session) but run on the agent's own selected model: no second, stronger model.
