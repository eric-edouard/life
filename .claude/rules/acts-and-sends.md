---
paths:
  - "apps/server/src/memory/draft*.ts"
  - "apps/server/src/memory/decision*.ts"
  - "apps/server/src/sources/**"
  - "apps/server/src/host/**"
  - "apps/server/src/todo-list/**"
  - "apps/server/src/apify/**"
  - "apps/server/src/memory/directory*.ts"
---

# What Life writes and sends, and the connector

`docs/tasks.md` ("The only sends", "The connector") and `SECURITY.md` ("What leaves the Mac") are the reference;
`scripts/imports.test.ts` checks the one send path and the one to-do writer.

## Only the owner writes `truth/`

Himself, or by his own words through one writer, `changeDirectoryEntry`, which runs `bun life validate`'s checks
first, one change at a time across processes (`oneAtATimeAcross`). Its doors:

- the connector's `change_directory_entry`, his app's taps included (a project's status, a picture: `said` is the
  tap's words or the line he tapped; 22 Nov 2026)
- his token's `answer_check`: a new person or organization he names answering a check, when no one holds that name
  (`addDirectoryEntryByHisWord`, life#721), and his Yes on an at organization card
  (`addOrganizationPersonByHisWord`, life#874)
- the main session's `change_directory_entry`, `said` found in his words of that ask (`hisWordsIn`; 22 Nov 2026)
- an agent's `promote` of an ask into a one-off project (`desk/one-off-projects.ts`; 28 Nov 2026): its goal and `said`
  are his words the main session told it (`read_spoken_ask`), only while his thread entry holds them, never the
  agent's text; the agent gives only name, id and area (none: a plain Personal area). The goal is his ask word for word.
- `bun life change-directory-entry '<json>'`, run by his own sessions on his words, never by another desk agent (a
  rule of the brief, not the send guard).

Models return JSON that zod validates; every quote is checked against its source (`memory/quote-check.ts`).

## Life acts in one place

- One to-do list backend per install (the `todoList` setting), changed through `changeTodoItem` alone, on his clear
  request or the auto-add permission. A missing feature is a capability (`can`), never a branch on the backend's name.
- Asks are his words handed to the agent, never acted on by Life. The desk is the one agent built in (`DESK_AGENT`):
  it applies his asks that name a change (`after.agentChange`) in code (`docs/tasks.md`).
- His calendar (his request of 8 Nov 2026): Life's own events only, the Past calendar and the appointments it reads
  (`docs/tasks.md`, "Appointments"). They are its reading, never an action on anyone's words: nothing is sent,
  accepted or booked; never guests or mail. One he deletes, or removes with `change_appointment` (his token, or the
  main session on his words), is never written again until his Undo. Its push carries an opaque id only.
- An agent's calendar event (21 Nov 2026): a card's one `event` need, written once when he picks its `adds` option
  alone (`answer_check`, his token only: `addEventByHisWord`, `host/card-event-calendar.ts`), never retried, marked
  `lifeOutput=card` so no sync rewrites it. Only Life's own reading may add unasked (its sureness); an agent's event
  always asks.
- An agent's Apify run (22 Nov 2026): a card's one `apify` need, started once when he picks its `runs` option alone
  (his token only: `runApifyByHisWord`, `host/card-apify-run.ts`), never retried, pay-per-event actors only, under the
  card's dollar cap. Agents get reads only (`find_apify_actors`, `read_apify_run`); `APIFY_TOKEN` never reaches them
  (`GATED_KEYS`).
- An access card's "I'm at my Mac" (28 Nov 2026): his pick of its `looks` option (his token only: `lookAtMac`,
  `host/done-seen.ts`) shows the next step not done on his own Mac, its permission prompt or its System Settings pane,
  through the permissions helper; nothing leaves the Mac.
- His Undo of a sent draft (25 Nov 2026; `undoAnswer`, his token only) deletes it only where the chat itself allows a
  delete for everyone (`deleteLineOf`, never a table of Life's).

## Life sends only a card's draft

His decision of 18 Nov 2026: exactly as shown, on his answer to its outgoing option, into the one chat named, once.

- Through Life's own bridges (a new 1:1 WhatsApp chat by its number), Messages.app for iMessage (no reply, reaction or mention), `gog gmail send` for
  mail (`sources/gmail.ts`; never reply-all, a quote, a signature or tracking), or `gh` on a repo in `githubRepos`
  (text only; 19 Nov 2026).
- A draft is text, one file or a reaction, with its reply target and mentions (`memory/draft.ts`). The chat is resolved
  when the card is asked (refused unless exactly one) and what he sees is stamped; the send reads only that stored
  line, and a file must hash to its digest or nothing goes.
- What a chat takes comes from its bridge's room features (`com.beeper.room_features`), never a table of Life's or a
  branch on a network's name; checked when asked and again before the send.
- It sends only on his pick of that option alone through `answer_check` with his app's token (never a paired agent, a
  session's command or the desk), by `answerDecision` alone. Never on silence, never with his words added, never
  retried: `not sent:` opens the card again for his new answer; `may have gone:` stays answered.
- His notification's Send (phone or Watch) is the same `answer_check`; a card that asks who its recipient is has none
  (19, 20 Nov 2026).
- Nothing is sent when anyone wrote in the chat since the card was asked or his last failed attempt; his own message
  there withdraws the card (life#731).
- A batch (28 Nov 2026; `docs/tasks.md`): nothing goes twice, never undone, refused (`notBuiltOf`) until his app shows
  every draft.
- One open draft per chat (`memory/draft-contest.ts`, `docs/tasks.md`; 21 Nov 2026). No agent withdraws another's
  card; a send his answer started holds its chat until it ends.
- Agents hold no send tool, and the send guard refuses their own sends (`desk/send-guard.ts`). A session in his own app
  sends only this way too: it asks the card as `owner` and answers it once he approved the exact text in that chat,
  never by typing in another app (19 Nov 2026).
- A file he approved leaves the Mac for its network (`SECURITY.md`). Life's only other mail and notifications go to him.

## The connector

Never add a tool that sends or edits anything beyond this list (`docs/tasks.md`, "The connector"):

- reads; his corrections and fact-check answers; `tell_life`; `request_decision`
- `answer_check`, his token only, through each kind's own writer: a draft's send, Start on a new matter (asks the
  desk), `adds` (`addEventByHisWord`), `runs` (`runApifyByHisWord`), an access card's `looks` (`lookAtMac`), `ends` and his Mark as done or Drop on a your move
  card (`endByHisWord`), a new directory entry
- `change_registered_agent`: his word, as an ask of the desk
- `change_todo_item`; `correct_memory` with `matter`, his token only: `correctMatter` ticks its to-do items, removes
  them on Drop, unticks them on `matter-reopened` (22 Nov 2026)
- `change_appointment` (his token: Remove, Undo); `change_setting` (his monthly amount and the edge's look; his token
  or the main session; 25, 26 Nov 2026)
- `sign_in_to_network` (his token: one bridge login step, passed on loopback, kept nowhere; only for a signed-out
  network; 26 Nov 2026)
- `ask_main_session` (his token, over the door's loopback, keeping nothing); his complaint reaches the caretaker only
  this way
- `change_directory_entry`; `delete_from_memory` (his token, or the main session at the door on his words; preview,
  then the write on its digest)

Its message poll first hears voice notes with no line (`hearVoiceNotes`): reading, not an act.

## Life serves no page

Only `/mcp`, its OAuth, the voice server's routes under `/voice` (forwarded as they came, their own tokens the only auth, never its map page;
`voice-forward.ts`), the status reads behind the local key, and the desk's door on loopback (one key per agent;
`/guard`, `/spending`, `/session` by a loopback `Host` only; `/main-session` behind the local key). Never take the
local key on the public port (`docs/architecture.md`, "Pages").

## Life signs its own tokens

`oauth.ts` is the one source of the issuer's address and the owner's subject; an app is approved by a pairing code from
the Mac. lifelog signs nothing for Life (24 Oct 2026).

## The ledger is the truth

The actions backend is an interface: what is read back can take authority away or reorder, never add it. What is open
is derived (`matterOf`), never stored (`docs/tasks.md`).
