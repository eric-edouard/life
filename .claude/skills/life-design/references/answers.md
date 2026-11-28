# Answers

What the main session writes when he asks something, and what the phone can draw of it.

## The data

- The 8 blocks and their bodies: `BLOCKS` in `apps/server/src/records/answer-blocks.ts:22`: `document`, `items`,
  `phrase`, `pictures`, `place`, `question`, `settings`, `table`. Each is checked when its fence closes; one that
  fails is dropped.
- How the session is told to answer: `MAIN_BRIEF` in `apps/server/src/desk/main-session.ts:86`, its block guide at
  `main-session.ts:82`.
- What the phone receives while it works (`thinking`, `step`, `words`, `block`, `reaction`, `answer`): see `flow.md`.

## The rules

`docs/design/philosophy.md`, "Answers to his questions" and "While Life works" (the 28 Nov lines first). A block the
system lacks is proposed as one general component, marked "new component".

