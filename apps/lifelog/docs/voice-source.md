# The voice-source contract

What a reader of lifelog can rely on: a program that follows the owner's recorded speech, never writes in the
background, and knows nothing of the phone. Lifelog never calls a reader and does not know which one reads it. Any other
voice recorder can offer the same routes and be read the same way. `openapi.json` has every shape; this page says what
the shapes mean.

## Auth

Every route takes `Authorization: Bearer <token>`. A reader gets its own token, never the phone's:

- `bun run --cwd apps/server mint-token read` prints a token and `READ_TOKEN_HASH`. It opens the reads below.
- `bun run --cwd apps/server mint-token corrections` prints a token and `CORRECTIONS_TOKEN_HASH`. It opens the reads and
  the corrections.

Only the hash goes in the server's environment. Mint again to rotate. A token on a route it doesn't open gets 403; an
unknown token 401. The phone's device token opens everything, the reads included.

`GET /capabilities` says what this source offers: `{ contract: 1, capabilities: [...] }`, each of `search`, `places`,
`corrections` and `status`. The feed and transcripts are always there. Lifelog offers all four.

## The feed: `GET /changes?since=&wait=`

- `since` is the cursor, a decimal seq. Start with `0` (or none) for everything. Keep the `cursor` of each answer and
  pass it next time.
- The cursor has no gaps: seq order is commit order, so a reader never passes a change it hasn't seen.
- A page holds up to 500 changes. Each row comes as it is now; a row changed again comes again with a newer seq. Keep
  rows by key and replace them. `more: true` means ask again at once.
- `wait=<0..60>` holds the request while nothing is newer, then answers an empty page with the same cursor.
- `removed` lists rows that are gone, `{ kind, ref }`: a turn moved off, a person merged away, a chapter a new summary
  dropped, a job withdrawn. Drop them.

What a reader needs from a page:

- **Conversations**: `id`, `startAt`, `endAt`, `kind` (`conversation`, `silent`, `dictation`, `imported`), `state`
  (`uploaded`, `transcribing`, `transcribed`, `summarized`, `failed`), `title`, `tldr`, `ownerTitle`, `place`.
  - `closed`: settled. The source heard on for 5 minutes past its end, so grouping adds nothing more to it. Late audio
    or an owner's edit can still reopen it, and the row comes again.
  - `retired: { successorId }`: merged or undone away. Drop what was built from it; the successor holds its words.
- **Turns**: keyed by `jobId` and `turnIndex`, with `conversationId` (the live conversation it falls in), `startAt`,
  `endAt`, `text`, timed `words` and `speaker`: `{ personId, personName, isOwner, displayName, label }`. Text never
  holds dictation or media. A renamed voice sends its turns again.
- **Chapters**: `id` (stable per conversation and start), `conversationId`, `startAt`, `endAt`, `title`, `summary`.
- **Jobs**: one recording each, `id`, `durationSeconds` (seconds of speech), `state`, and `endedOnSilence`: true when
  nobody spoke for at least 30 s after it, so no turn follows it closely. False says nothing either way: a long
  recording is cut at 2 minutes or at a 5 s pause, before anyone knows what follows. Null on older jobs. A reader
  waiting for the end of what someone said uses this, then `closed`, rather than any timing rule of its own.
- **People**: the owner's people, with their aliases.

The page carries more for the phone (`edits`, `quietRanges`, `mac`, `switches`, `vocabulary`). A reader may ignore it.

## Words on demand

- `GET /transcription-jobs/{id}/transcript`: a job's turns; a turn's index in `turns` is its `turnIndex`.
- `GET /conversations/{id}`: one conversation with its range, titles, latest summary and jobs.

## Optional parts

- **search**: `POST /search` with a query; passages of about 30 to 60 s, best first. Matching by meaning needs the
  server's embedding key; without it, words only.
- **places**: `GET /where?at=` (an instant: the stay around it; a day: each stay) and `GET /visits` (by `place`, or
  `latitude`, `longitude`, `radiusM`; `from`, `to`; at most 200, newest first). A stay is
  `{ place?, latitude, longitude, arrivedAt, leftAt }`.
- **corrections**, only the owner's explicit ones, never in the background: `PUT /transcripts/{jobId}/speakers/{label}`
  (with `turnIndex` for one turn), `PUT /conversations/{id}/title`, `PATCH /people/{id}`, `POST /people/{id}/merge`.
  Splits and merges stay in the app.
- **status**: `GET /status`. `pendant` (`connection`, `recording`, `recordingKnownAt`, `batteryPercent`, `charging`,
  `knownAt`), `phoneHeartbeat` (the phone's last report, `backlog.pages` among it), `pipeline` (where audio and
  summaries are, `docs/transcription-server.md`) and `backup` are typed; the rest is for the owner's own sessions and
  may change. `GET /status/live`, its cheap part, is the device token's only.

## Still to change

The OAuth issuer in `packages/auth` (Better Auth, the sign-in and consent pages, `scripts/owner.ts`) signs tokens for a
reader's own MCP clients. It goes once that reader runs its own authorization server.
