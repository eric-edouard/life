# Answers

What the main session writes when he asks something, and what the phone can draw of it.

## The data

- The 8 blocks and their bodies: `BLOCKS` in `apps/server/src/records/answer-blocks.ts:22`: `document`, `items`,
  `phrase`, `pictures`, `place`, `question`, `settings`, `table`. Each is checked when its fence closes; one that
  fails is dropped.
- How the session is told to answer: `MAIN_BRIEF` in `apps/server/src/desk/main-session.ts:86`, its block guide at
  `main-session.ts:82`.
- What the phone receives while it works (`thinking`, `step`, `words`, `block`, `reaction`, `answer`): see `flow.md`.

## The rules in force (philosophy.md, "Answers to his questions", "While Life works", 28 Nov log)

- One headline sentence that answers him ("Yes, Jade answered at 9:12."), then blocks over prose, then 2 or 3
  follow-ups as a `question` block. Aim for one phone screen.
- Answer directly, then go on: "What's on today" shows the day at once, then "You also have 3 decisions to make" and
  their rows.
- One format for a day, the same everywhere: its events as a vertical timeline (a sideways row fails past three).
- "Did Jade answer?": when and what, then her chat, then the ready draft. "Tell Ben…": straight to the draft card.
- The act first, its figure second: "Pay the electricity bill", then 84 €.
- A block reads on its own: no row he can't place (a bare "Maps", a lone event title, a floating face).
- Several items come as rows; a single item arrives unfolded in place.
- While Life works: one quiet step line, a verb and its object ("Reading your chat with Nora"), each replacing the
  last; never a list, never a tool's or agent's name.
- Failing to answer: "I couldn't answer that."
- A block the system lacks is proposed as one general component, marked "new component".
