---
type: grilling
blocked_by: []
---

# The threshold

## Question

What exact test does the main session run, in seconds, to tell an ask it answers now from a project? Which signals count (needs the user's input partway, takes more than minutes, changes or deletes their things, spans days), what it says to the user in each case, and what happens when an ask it took as quick turns out to be a project midway.

## Answer

Decided with the owner on 28 Nov 2026. The main session has three ways out of an ask: answer it in its turn, hand it
to an agent as handed work (`tell_agent` with its kind), or make it a project. The threshold is the line between
handed work and a project.

- **A project is a result to shape:** something made or reshaped that the user should see before it is done (a
  cleaned-up library, a mini app, a trip plan, a document), or a change to or deletion of many of their things.
  **Handed work is an errand with a known shape** (reply, redraft, look up, research, book), even when it waits days
  on someone. Examples: "plan my trip to Japan", "clean up my Downloads folder" and "make a website for my mother's
  bakery" are projects; "find me a dentist" is handed work.
- **Unsure in seconds:** the main session hands it as work; the agent's first look decides, and it promotes it.
- **Promotion midway:** the agent says so at its door; Life creates the project from the user's original ask (their
  words, kept with the handed work, are its `said`), with no question asked, and the work moves to the project's own
  agent. The user sees it become a project.
- **An ask about an existing project** goes to that project's agent, never a new project (a default, not asked).
- Never a "make this a project?" question, at the start or midway.
