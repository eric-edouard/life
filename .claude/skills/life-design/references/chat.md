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

## The rules in force (philosophy.md, "Drafts", 28 Nov)

- Head: the person's or group's picture (initials when none), the name, the app's name, and an arrow that opens that chat.
- Only the messages that matter to the ask; the rest one quiet count ("3 unrelated messages"), not tappable. At most
  the last 5 cited messages plus the one replied to; older ones are "Earlier in WhatsApp".
- It scrolls, and opens at the bottom on the latest; never an endless scroll. Tapping a message opens the real chat.
- It looks like its app, adapted to Life's look. His messages take the app's colour mixed into black.
- The draft takes the app's own sent-bubble colour with a 1.5 px dashed outline that fades once sent. Quick edits
  (Shorter, Warmer, In French) need no Undo.
- One open draft per chat: another ask into the same chat waits behind it.
