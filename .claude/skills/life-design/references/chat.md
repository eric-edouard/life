# The chat component

One component, used wherever a chat shows: in a draft card, in an answer ("Did Jade answer?"), in a profile.

## The sources

- The shared drawing: `ChatCard` in `docs/design/2026-11-23-chat-first/2026-11-26-design-lab/card-blocks.js:478`
  (exported as `CB.chat`, `card-blocks.js:514`); its data `{to, face?, app, chat:[{who,t,at}|{me,t,at}|{unrelated:n}],
  draft}` is documented just above it. Apps and their colours: `APPS` at `card-blocks.js:69`.
- The capability grid, what a chat takes: `ChatTakes` in `apps/server/src/sources/contract.ts:55` (reply, mentions, a
  reaction, a file). Per room, the bridge says which; draw each one the grid has, never one it lacks.
- The three looks explored (as the app, as Life's thread, as a transcript): `docs/design/2026-11-28-chat-component/index.html`.
  Until he picks one, `CB.chat` is what turn by turn v3 draws.

## The rules

`docs/design/philosophy.md`, "Drafts" (the 28 Nov lines win over the 23 Nov ones).

