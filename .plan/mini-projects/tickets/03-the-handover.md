---
type: grilling
blocked_by: [01, 02]
---

# The handover

## Question

At "let me look into it", what does the main session do and pass on: creating the project, registering its agent (one agent per project), handing the user's words verbatim, and the first thing the user sees. What it never does itself.

Also the promotion path (The threshold): handed work an agent promotes to a project midway, created from the user's original ask, moving to the project's own agent.

## Answer

Decided with the owner on 28 Nov 2026.

- **One act by the main session:** at "let me look into it" it writes the one-off project (`change_directory_entry`,
  with its `goal`, the user's words as `said`) and answers. Writing a one-off project makes Life's code register the
  project's agent and hand it the user's words; nothing rests on the main session remembering the rest. The main
  session never works on it.
- **The first wake** carries the user's ask verbatim, the project, and a link to the Ask Life conversation around the
  ask (read as data, so the agent never asks what was already said); the agent loads the engineering playbook skill.
- **Promotion midway:** when an agent holding handed work says at its door that it is a project, Life writes the
  project from the user's original words (kept with the handed work), registers a new agent for it, and moves the
  work there with its notes through the existing move (`hand_over`). One agent per project holds: the Personal agent
  never becomes a project's agent.
- Later words of the user about the project reach its agent through the main session (`tell_agent`), as for any
  project.
