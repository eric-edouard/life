# Sync between the phone, the server and the Mac

What each side owns, how it travels, and the wire formats that `openapi.json` doesn't cover.

The phone captures, places audio in capture time, labels speech and uploads; the server owns everything after. The
Swift client is `ServerClient`, in the Kit target `ServerAPI`, one file per server domain. `ContractTests` checks its
enums and paths against `openapi.json`, and `WireTests` reads the server's real answers in `fixtures/wire/`. A server
enum the app doesn't know decodes as `unknown` (`UnknownTolerant`).

## The driver

One run does all of it: Kit's `Driver.run`, whose steps `Driver.swift` lists: the outbox, derived audio (and, once a
day, old playback files evicted), one pull of the feed, the push token, the uploader (speech fragments, then timeline
facts with `sentThrough`) and the location history. The push token goes with the runs, never only at launch, until the
paired server has it, and once more after each launch (`PushToken`): iOS hands it over before pairing or offline, the
server drops a token APNs refuses, and a phone whose token the server lacks is never woken.
The feed goes before the uploader, so fragments leave out the newest quiet
ranges, and the cursor moves back for the fragments the server withdrew. `SyncStore` in the app only starts
it: after each Bluetooth sync that saved audio, on the server's silent push, on an edit, in a background task, when
the app comes forward, when the network returns and on the Shortcuts action "Sync lifelog" (`docs/pendant.md`). One task
does it, one run at a time; a trigger during a run makes one more. In the background, a run that only new audio asked for starts at least 15 s after the previous run started
(to save CPU); the trigger is remembered, and any other one (push, edit, Shortcut, becoming active) runs at once. If iOS
suspends the app first, the request stays set and the next wake's trigger runs it. The raw backup is not in the run: one item can take
minutes, and during talk a run is asked for every 1.5 s, so after a run that reached the server, on Wi-Fi or power,
`SyncStore` starts a backup round in a second task beside it, one round at a time (with the backup last in the
run, feed pulls were a median 113 s apart in talk, 11.5 s without it). Each run logs `run.done` (its milliseconds and
the process's CPU milliseconds, each step's as wall/CPU) and each fragment `upload.sent` (pages, audio, milliseconds to render and send, and milliseconds since its
last kept second), read with `bun run events run` and `bun run events upload`. With a simulated Pendant in the simulator the run
has no capture half: only the outbox and the feed go. In the foreground that same task then long-polls the feed
(`wait=25`), and a trigger cuts the poll short: nothing else pulls. Screens read again only when a run or a pull
changed something, or the outbox did. Offline, a run stops at its first request and the next one starts again from
the top; nothing is lost or sent twice.

## Who owns what

| Data | Owner | Copy on the other side | How it travels |
| --- | --- | --- | --- |
| Pages, receipts, ACK, clock model, speech labels | Phone | None | The iPhone never sends them; the server sees fragments and timeline facts |
| A thin phone's raw pages (the Android app) | Phone until ACK; the server keeps its copy | Server `raw_pages`, audio store `pages/…` | `PUT /sources/{id}/pages/{firstPage}`, `GET /sources/{id}/ingest` (below). The server labels and cuts them (`docs/processing.md`) |
| Labels, timeline spans, heard-through and sent-through of a raw-page source | Server | Server `page_pieces`, `timeline_spans`, `sources` | Written only by the server's page processing; the timeline route ignores a page source's heard-through and sent-through |
| Timeline facts, heard-through and sent-through | Phone | Server `sources`, `timeline_spans` | `PUT /sources/{id}/timeline`; a span replaces the one with its first page; heard-through only moves forward; `sentThrough` is the phone's latest word, where its first kept second not sent starts |
| Speech fragments (speech-only Ogg Opus of whole pages) | Server: the fragments, which pages it holds, and where blocks close | The phone keeps the raw packs and one cursor | `PUT /sources/{id}/speech/{firstPage}`, once per fragment; `GET /sources/{id}/blocks` the pages the server holds (jobs and open fragments), read when the cursor moves back; `sentThrough` on the timeline (`docs/timeline.md`) |
| Raw packs, `source.sqlite` snapshots, audio of old jobs | Phone | Server audio store `raw/…`, `jobs/…` | `PUT /backup/packs/{sourceId}/{name}`, `PUT /backup/source-db/{sourceId}`, `PUT /jobs/{id}/audio`; `GET /backup/{sourceId}` says what is held (`docs/formats.md`) |
| Conversations, their ranges and ids | Server (grouping) | Phone cache, read-only | Feed |
| Words (turns in capture time) | Server (`turns`) | Phone cache, read-only | Feed. A conversation's words are the turns starting in its range; each turn carries its `conversationId`, which the phone reads (a regroup logs the turns whose conversation it changed), and `words`, each word's time and length in its text, which playback lights |
| Chapters, titles, summaries | Server (the Mac runs them) | Phone cache | Feed |
| Speakers, people, voice profiles | Server | Phone cache; answers are requests | Feed; answers through the outbox |
| Voices to name | Server | The last answer, in Caches (`naming-queue.json`) | `GET /naming-queue`, not in the feed; the one server answer kept outside the cache, shown at once and read again in the background. People and their aliases come in the feed; rename, aliases and merge go through the outbox. A clip is the job's stored audio (`GET /transcripts/{jobId}/audio`, from `audio.start` seconds, never past its stretch of kept speech) or, from before the audio store, the phone's recording, `at` to `until`; its timed `words` count from `at` in both, and its turn (`jobId`, `speakerLabel`, `turnIndex`, `personId`). `likely` is his people with a voice profile, the most like this voice first, for the phone to order its names by. "Several people" names each clip's turn in place (`PUT /transcripts/{jobId}/speakers/{label}` with `turnIndex`), then sends `several` (`people`, `unknown`), all through the outbox; after `several` the phone sends Generate (`POST /conversations/{id}/intelligence`) for each of the voice's conversations |
| Voices to recheck | Server, derived from named voices and other conversations | `NamingQueue` appends them after the voices to name, outside its count | Device-only `GET /naming-queue/rechecks`, same card shape with kind `recheck`, `namedPersonId` (the person the owner named) and `personId` (the suggested person); existing `POST /naming-queue/answer` settles it; excluded from push, badge and map |
| Owner edits: split, merge, undo, dismissed suggestion, title, vocabulary, summary asked for | Server, as intents | Phone outbox until accepted | The outbox (`OwnerIntent`): `POST /edits`, `PUT /conversations/{id}/title`, `PUT /vocabulary`, `POST /conversations/{id}/intelligence` (`{ after }`: the run shown). Shown at once as "waiting to sync" (`PendingEdits`); a refused one shows the server's message and the screen goes back to the feed's value |
| A press of the Pendant's button | Phone; nothing on the server | The words come back, never stored; only the call's cost (`quick_transcriptions`) | `POST /quick-transcriptions` (the window's Ogg Opus) answers `{ text }` |
| Location fixes and visits, with Apple's place names | Phone | Server `location_history` | `POST /location-history`, each sent once |
| A conversation's place | Server (its most accurate named fix) | Phone cache | Feed (`place`) |
| Split suggestions | Server (the latest valid run's medium boundaries, minus dismissed ones) | Phone cache | Feed (`splitSuggestions`) |
| Quiet ranges from the Mac | Server (made from the events on the Mac's socket) | Phone cache, left out of fragments | Feed |
| Quiet ranges from playback | Phone | Server `quiet_ranges` (source `playback`) | Left out of fragments on the phone; a closed span goes through the outbox to `POST /quiet-ranges`, in pieces |
| Mac watermark, Mac LLM state, dictating | Server, live | Phone cache (`feed_state`) | Kept from the last page of a complete pull, with when it ended (`pulledAt`, the last sync the status shows) |
| Transcription and AI switches, engine, transcriber, minutes before the app asks to be opened | Server (`processing_switches`) | Phone cache | Every feed page; the phone sets them with `PUT /switches`, through the outbox |
| The owner's vocabulary | Server (`vocabulary`) | Phone cache (`feed_state`) | Every feed page, as one value; the phone sets the whole list with `PUT /vocabulary`, through the outbox |
| Why a conversation waits | Server (`waiting_reason`) | Phone cache | Feed (`waiting`); the status sheet lists them |

The phone keeps no mirror of server state beside the cache (and the two Caches files above). A conversation's state
is the feed's `state` (Uploaded, Transcribing, Transcribed, Summarized, Failed); the phone adds only Not uploaded
yet, while audio of it is still only on the phone (`ConversationState`, `Uploader.unsent`). The status every tab
shows comes from the network path, the uploader, the outbox and the last pull (`ConnectionSummary`): kept speech
past the uploader's cursor counts as Uploading, and the sheet shows why the last fragment failed.

## Raw pages from a thin phone

`PUT /sources/{sourceId}/pages/{firstPage}` takes up to 500 pages as one multipart upload: `pages`, the raw records
concatenated in index order, and `metadata`, a JSON `PageBatch` (`fixtures/wire/page-batch.json`): `codec`
(`limitless` or `omi`), the `sha256` of `pages`, and each page's `index`, `length` and, when the phone placed it,
`startMs`. An index is the phone's store index: the flash life times 2^40 plus the device's own (`FlashLife`).

- The pages must be contiguous from `firstPage`; a batch may start past what the server holds, where the device lost
  records.
- A page already stored with the same bytes is accepted and kept once, so a batch sent again, or one overlapping it,
  is safe. Any 200 means every page of the batch is with the server.
- A stored index sent with other bytes refuses the whole batch with 409 `page_conflict`, nothing kept, naming the
  first such index (`page`): a new flash life needs its own band of indices, from there on.
- A bad hash, lengths that don't add up or a gap inside the batch: 400. The audio store down: 503 with `Retry-After`.
- The bytes go to the audio store (`pages/<sourceId>/<firstPage>-<sha256>.bin`) before the one transaction that
  records the pages (`raw_pages`).

`GET /sources/{sourceId}/ingest` answers `IngestState` (`fixtures/wire/ingest-state.json`), as does every 200 above:
`highestPage`, the highest index stored, or null, and `labeledUntil`, the capture time the server's labels reach,
or null. `highestPage` is a hint, not a resume cursor: a ring overwrite or a 503 leaves holes below it, so the phone
resumes from its own 200 answers. Both routes take the device token only. The phone still ACKs only what it holds
durably (the iPhone's `ackableIndex`, Android's `DrainedRun.advanceTo`): the server's copy never frees the device.

## Edits and the outbox

The outbox holds each edit as the owner's intent (`OwnerIntent`, Codable), with a client uuid and when it was made,
in the order made; it becomes its request only when sent (`OwnerIntent.request`). A run replays them one by one. A
2xx takes an edit out. A 4xx other than 401, 403, 408 and 429 keeps it as refused, with the server's message, until
the owner reads it; the next edit goes on. Anything else (offline, a 5xx, the token refused, too many requests) stops
the replay there, so nothing overtakes an earlier edit. Every edit is idempotent by its content or by an id the phone
chose: a grouping edit's id is its uuid, and a speaker answer naming a new person carries that person's uuid, so a
replay names the same person.

## The feed (`GET /changes`)

`feed.ts`: `since=<seq>`, a decimal (`0`, or none, for everything). The phone keeps it in `library.sqlite`
(`LibraryCache.swift`), each row under its key, and drops what `removed` lists. Readers read it too, with the same seq.

Every writer of something the feed carries logs `(kind, ref)` in `change_log`, last in its own transaction
(`change-log.ts` `logChange`). Kinds: `conversation`, `turn` (`<jobId>:<turnIndex>`), `chapter`, `job`,
`person`, `assignment` (a job id), `quietRange`, `edit`, `mac` and `switches`. A lock held to commit makes `seq` commit order, so a reader never passes a change it hasn't seen.

- A page is up to 500 log rows after the cursor, each `(kind, ref)` once, loaded as it is now. A row changed again
  comes again under the same key, with a newer `seq`. `more`: ask again at once.
- `wait=<0..60>` holds the request while nothing is newer (the server reads the newest `seq` each second and holds no
  connection), then answers an empty page with the same cursor.
- Turns carry the live conversation they fall in (`conversationId`): the server's placement is the one rule, the
  phone places nothing by time. A regroup re-sends only the turns whose conversation changed.
- Turns carry their speaker with `displayName`, the one name every reader gives it (`transcript.ts` `speakerNames`):
  the person's name, else "Speaker N" in its conversation, as the summaries render it. Text is already without
  dictation and media (`keptWords`, the one hiding rule); empty when all is hidden. A speaker change re-sends the
  conversations it speaks in, with their chapters and turns; audio landing before words already there (late, or sent
  newest first) re-sends its conversation's turns, whose numbers may move.
- Conversations carry `kind`, `state` (`uploaded`, `transcribing`, `transcribed`, `summarized` or `failed`:
  `conversation-state.ts`, the one rule), `runId` (the summary shown), `place`, `waiting`, `splitSuggestions`, `startEdit` and
  `endEdit` (the live split each edge comes from, or for `startEdit` else the merge that joined it: what Undo undoes)
  and, once merged away, `retired`; `closed` once grouping is done with it (`packages/db/src/schema` `isSettled`). A dismissed
  suggestion re-sends its conversation.
- Jobs carry their state, pages, `durationSeconds` (seconds of speech audio) and `endedOnSilence` (true: the cutter
  closed the block on 30 s with nothing kept, `cutter.ts` rule 3; false: the cap or a pause closed it, whatever
  followed; null on jobs older than the field); the phone keeps no job rows. Each
  page also carries the owner's `vocabulary`, `mac.dictatingSince` (null once the dictation rules let a flag go,
  at 10 minutes) and `mac.subscriptions` (the Mac's last subscription limits, below), whole.
- `removed` lists rows that are gone: a turn a new map moved off, a person merged away, a chapter a new run dropped,
  a job withdrawn unsent because a quiet range touches it. A withdrawn speech fragment is listed the same way, kind
  `job` with the fragment's id, as is each fragment of a withdrawn job, with `firstPage` and `sourceId`: the phone
  moves its cursor back there before it saves the page (`Driver.pull`), so a kill in between loses nothing.
  Who spoke travels on each turn (`speaker`); naming a voice sends its turns and conversations again.
- Chapters are rows (`chapters`), written after every valid summary run; an id is stable per conversation and start.
- `mac` and `switches` come whole on every page; their log rows only wake long polls.

## Readers

A reader (a program following the owner's speech, never the phone) uses the routes in `docs/voice-source.md`, with
its own `read` or `corrections` token. Lifelog never calls it.

`GET /status` is for the owner's own sessions: the archive's invariants, the Pendant, the phone, the Mac, summaries
waiting, the backup, ElevenLabs and the last day's problems. Spending stays out of chats; the phone keeps
`GET /usage/summary`.

## The archive's invariants

`archive-health.ts` counts five things that must be 0: turns in no live conversation, live conversations that
overlap, search passages of a conversation that isn't live, the owner's speaker names on a job no live
conversation holds, and pages held twice (by two jobs that aren't failed, or two fragments). It runs every hour, emails the owner when a count rises (at most once per 12 hours) and is read
by `GET /status` and `bun run --cwd apps/lifelog/apps/server check:archive`.

## After the cutover

The phone handed over once (`POST /handover`, now gone): the server's conversations became the phone's live set, old
parts' pages went on their jobs, and each source got `handed_over_at`. A reinstalled, restored or new phone's
uploader starts its cursor and its timeline at the page holding the source's `sentThrough` (`GET /sources/{id}/blocks`,
only once `handedOver` is true), the last install's word: everything before it was sent or decided. So it never reads
derived files from before it, which backups leave out and a new phone doesn't have. It sends around the server's
pages; without a `sentThrough` it starts at the first page. Speech from before the cutover that no old part holds
goes up like any other (`docs/processing.md`), except audio from before the Mac's first quiet range, which the server
covers. How ids are made and how a block maps back to capture time: `docs/formats.md`.

## The Mac helper's socket

The same authenticated socket also accepts `subscription.usage` frames: `engine` (`claude` or `codex`) and a
`reading` with `observedAt`, `fiveHour` and `sevenDay`. Each window is `null` or `{usedPercent, resetsAt}`; times are
Unix seconds. The Mac reads Codex's account limits every five minutes while awake and connected. Claude's last
status-line observation keeps its original time. Neither operation makes a model call. Only percentages and reset
times leave the Mac. The server retains the latest observation for each engine across disconnects and restarts;
older observations and clocks more than a minute ahead cannot overwrite it. The feed's `mac.subscriptions` carries
them (`{claude, codex}`, each a reading or `null`), like the Mac's other state; the app writes them to the app group
after each pull, and the Lock Screen dials read only that.

The Mac helper (`apps/mac-quiet`) opens one WebSocket at `GET /quiet-ranges/socket?protocol=2` with the Mac's token
as a bearer (`MAC_TOKEN_HASH`). It pings every 30 s. The server's side is `mac-socket.ts`. Another protocol (a
helper older or newer than the server; no `protocol` is 1) gets `426` with what to install, and `mac.refused`.

The helper is a sensor and a runner: it reports raw facts and runs what it is told; every rule is the server's.

The server speaks first, on every new socket, with the last seq it applied (`mac_watch.last_seq`):

```json
{ "type": "welcome", "lastSeq": 1792670000119 }
```

The helper sends nothing before it. If no welcome has numbered its outbox file yet (a new file, or the old one lost),
nothing in it was sent: it numbers every queued event above `lastSeq`, in order, and every later one too, so a lost
file with a clock behind the server's count is never taken for a resend. Once numbered, its count stays above the
server's, so it keeps every seq: an event at or below `lastSeq` is one the server applied whose ack was lost, acked
again and never applied again (out of order, an old mic-off could close a later dictation).

From the Mac, events, each with its seq:

```json
{ "type": "mic", "seq": 1792670000120, "at": "2026-10-11T08:00:00.120Z", "capturing": ["com.FluidApp.app", "com.apple.FaceTime"] }
{ "type": "sleep", "seq": 1792673600000, "at": "2026-10-11T09:00:00.000Z" }
```

`mic` comes whenever the set of processes with the microphone on changes, and once when the helper starts; `sleep`
before the Mac sleeps. `seq` grows with each event: one more than the last, or the time in ms if that is greater, and
always above the welcome's. The server caps each `at` at its own now (a Mac clock running ahead puts no hold or range
in the future), applies an event only when its seq is greater than the last it applied, runs it through the
dictation rules and answers `{ "type": "ack", "seq": 1792670000120 }`, which also covers every event before it. A seq
no greater than the last applied is a resend, acked and not applied, unless its time as the Mac sent it (`at`, before the cap) is later
than the last applied event's (`mac_watch.last_at`): then the helper's count went back, and the event is refused (`mac.seq_behind`, close
code 4409) and blocks, never dropped. The helper keeps an event in its outbox file until the ack and sends the whole
outbox again, in order, on every new socket and every ping. After its outbox, each socket's first word is

```json
{ "type": "hello", "engines": ["claude", "codex"], "running": ["…"] }
```

A hello means the Mac is awake. `running` lists the model calls the Mac still runs from before this socket; after a
server restart they hold their slots until they answer.

The dictation rules (`dictation.ts`, the owner's of 10 October): only the dictation apps listed there count (Mac
bundle ids and their helper processes; Windows images, `*.exe` in any case, from their own table; calls are
conversations, so FaceTime and browsers don't); each dictation is padded 1 s before and 1.5 s after; dictations less
than 5 s apart are one; one over 10 minutes, or cut by sleep, is dropped; a flag on past 10 minutes stops holding the
watermark at once and counts again only once off. A dictation done waiting for a neighbour becomes a quiet range 5 s
after it ends, or at once when the socket closes (one that comes after is its own range). The state (a dictation open,
or finished and waiting, a block, and whether the Mac sleeps) is in `mac_watch`, so a restart loses nothing. Only
dictation apps are named on the server: `mac.event` counts the other processes capturing (`others`), and the helper's
own log names them, to find a missing dictation app.

The watermark: once the socket said hello, the Mac vouches that every dictation before now is among the quiet ranges,
except from the padded start of a dictation not yet a range. When the socket closes, it stops at the last hello, ping
or pong heard, or the time of the last event applied, whichever is later, in server time; held back the same way. A
Mac asleep, or silent for 2 hours (off, or the helper gone), vouches through now, except while something is held when
it went: then the watermark stays there. Events apply only in the order sent: one the server can't apply closes the
socket unacked and blocks the watermark from 1 s before the Mac was last heard, whatever the silence, until the
helper's next event applies. The close says why: `invalid event` (code 4400, `mac.event_invalid`: the helper logs the
event, drops it and queues a fresh `mic` with what captures now, so the next one applies at the reconnect; when one
does, the span from the block to it becomes a quiet range of
source `unknown`, since the dropped event may have started a dictation; the helper trims names and lists to 200 and
sends only valid times, so only a bug makes one), `seq behind` (4409: the helper marks its file not numbered, so its next welcome
renumbers what remains), or 1011
(`mac.event_failed`, the database: it sends the event again). A block records `mac.stuck`, and every recent
conversation that ends after it waits with reason `macAway`. If one ever stays (a helper that keeps sending an event
the server refuses), the helper's log says which; delete that event from
`~/Library/Application Support/lifelog-quiet/outbox.json` while the helper is stopped, and the block clears once the
next good event applies. `POST /quiet-ranges` is for the phone's playback ranges (`source: "playback"`, the owner's
token); the Mac's token opens the socket only.

The cutover from protocol 1 (ranges sent by the helper) keeps its hold: the migration turns a watermark held behind
the last time the Mac was heard into a block, which the new helper's first event clears, and the new helper sends an
old `outbox.json` of ranges as the events that make the same ranges. In order: let a dictation finish and the old
helper's outbox drain (its log says it was acked), stop the old helper, deploy the server, then install the new
helper. Lifelog Host ships both in one build, so a Host update does all of it.

The same socket carries model calls the other way. The server sends:

```json
{ "type": "llm", "id": "…", "engine": "codex", "model": "gpt-6.1-sol", "effort": "medium", "system": "…", "prompt": "…", "schema": {}, "maxTokens": 16000, "timeoutMs": 170000 }
```

The Mac runs Codex or Claude Code on the selected subscription, in an empty folder with no tools (that stays the
helper's, so the server can't run tools on the Mac), kills it at `timeoutMs`, and reports what happened, raw:

```json
{ "type": "llm.output", "id": "…", "stdout": "…", "stderr": "…", "final": "…", "status": 0, "timedOut": false }
{ "type": "llm.unrun", "id": "…", "signedOut": true, "unrun": "no claudeToken in secrets.json" }
```

`final` is Codex's answer file. The server reads it (`mac-llm.ts`): Claude's structured output, else its result;
Codex's final answer once a turn completed; else a failure, `auth` (the CLI is signed out), `limit` (the plan's
limit), `timeout`, or `failed`, with one line of detail and anything shaped like a key removed. The hello must list
`engines`; the Mac runs only the engines it lists. A new run freezes its engine; each completed call stores the
actual provider, model and reasoning effort. `auth` and `limit` fail that engine's calls and keep them off the Mac
for 10 minutes.

The server sends at most 4 calls at once (`MAC_SLOTS`), counting those the hello says still run; the rest wait on
the server. A call's 3 minutes start when it is sent, and a call unanswered by then fails alone. A closed socket
fails the calls not sent yet. The calls sent stay: the Mac keeps running them and answers on whichever socket is
open when they finish. An answer that comes after its
call failed (for up to 30 minutes) is still kept for its run when usable. A failed call's run waits for the Mac and
later resumes from its kept answers (`docs/processing.md`). Model calls never go to a paid API.
