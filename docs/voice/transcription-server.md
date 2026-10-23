# Transcription on the server

How the phone's audio becomes a transcript, what the server keeps, how it avoids paying twice, and how the server
runs.

## Audio

- The phone uploads **speech fragments**: the kept speech of a run of whole Pendant pages the server doesn't hold, as
  Ogg Opus, with its pages and map (`PUT /sources/{sourceId}/speech/{firstPage}`). A page is in one fragment.
- The server measures each file's duration from its Ogg pages and refuses it when it differs from the declared one by
  more than 1 second, or when its map runs past its audio.
- A fragment waits in the audio store (`fragments/<sourceId>/<firstPage>-<sha>.ogg`) until the **cutter**
  (`cutter.ts`) closes its block: at 2 minutes of speech, at a pause the phone saw (`sentThrough`), or 30 s after the
  last speech by the server's clock. A closed block passes the Mac's gate and the quiet ranges, is joined into one Ogg
  (a remux, `joinOggOpus`, with the exact `starts` of each stretch in its map) and admitted as one job. The cutter is
  the only way a job is made.
- A job's audio is stored at `blocks/<sourceId>/<firstPage>-<sha>.ogg`, an older part's at `jobs/<sha>.ogg`. The **audio
  store** is a folder (`AUDIO_DIR`, what Lifelog Host uses) or an S3 bucket (all five `S3_*` variables, which win when
  set); the keys are the same relative paths in both. The server does not boot with neither; only tests keep the audio
  in memory. If the store fails, nothing is kept and the answer is 503 `audio_store_unavailable`.
- Every send to ElevenLabs reads the audio from the audio store, so a retry never needs the phone. Jobs older than the
  audio store have no audio there until the phone backfills it
  (`PUT /jobs/{jobId}/audio`); nothing sends them again.
- ElevenLabs keeps its own copy of the transcript under its retention policy (zero retention is enterprise-only). Its
  retention period is not documented.

## What the server keeps

- One row per fragment (`speech_fragments`): its pages, map and capture range; its audio's key while its block is
  open; the job it became. One with neither key nor job is covered: bought already, its pages held.
- One job row per block (or older part): state, attempts, provider ids, prepared duration, errors, the audio's key, its
  pages (`[[first, last], …]` JSON, its fragments' union), and its time map (`map`, `capture_start`, `capture_end`): how a
  position in the prepared audio maps back to capture time (`docs/formats.md`). `capture_end` is the block's last
  instant of speech. A map never moves after admission; a span placed again more than 1 s off under a job's pages is
  logged (`job.span_moved`). An older part's map was copied once from the conversations that cited it (migration
  `rebuild`).
- `GET /sources/{sourceId}/blocks` answers the pages the server holds (every job's, any state, and every open
  fragment's), so the phone sends around them, and `handedOver`, whether the cutover happened.
- The provider's raw result and a parsed transcript (words with times on the uploaded audio's timeline, speaker
  labels, confidence, and turns split on speaker change). The raw result stays so transcripts can be re-parsed later.
- `turns`: one row per transcript turn in capture time (`start_at`, `end_at`, speaker label, text, language, its words
  on capture time), keyed by (job, turn index) as the owner's speaker assignments are. It is a cache, rebuilt from the
  parsed transcript and the job's map (`captureMillis`) in the same transaction as the job's completion; a transcript
  an older parser made gets its words again from its raw answer on the next rebuild. Each rebuild logs the job's
  turns for the feed. A conversation's words are the turns that start inside its range (`transcript.ts`); a job is
  bought once (the admission check and the identity index), so no turn is counted twice.
- Every change of a job's state or pages is logged for the feed (`change_log`, kind `job`) in the same transaction;
  a withdrawal is logged as `withdrawn`, and the feed lists it as a removed job with its first page.

## The job worker

- States: `queued` → `submitted` → `completed`, or `failed`. One worker in the server sends jobs (`jobs.ts`). A
  stored fragment, the phone's timeline, a webhook, every state the Mac sends, the transcription switch turned on,
  the 5-minute tick and the instant the next block may close start it; each run closes the blocks due first.
- It sends queued jobs that have audio in the audio store and whose `next_attempt_at` has passed, oldest
  first, at most `ELEVENLABS_SLOTS` at ElevenLabs at once (default 10; set it below your ElevenLabs plan's concurrency, a block takes one). A job
  counts there from its send until its answer, or 30 minutes.
- Nothing is sent while transcription is switched off or the credits are used up: jobs wait queued.
- Not taken is not an attempt: a 429, a 401 or 403 (the key or the plan), a connection that never opened, or an audio
  store that can't be reached. ElevenLabs can't have billed it; it goes back to `queued`, next attempt in a minute.
- Taken but bought nothing (a failure webhook for this send, a job ElevenLabs answers 404 for 30 minutes after it was
  sent): an attempt. `attempts + 1`, provider ids cleared, back to `queued` after 1, then 2 minutes; the third
  attempt that fails fails the job, so a failure that repeats never loops. ElevenLabs bills only the transcripts it
  makes: lost jobs are missing from its usage. A webhook names its send (`attempt` in
  its metadata), so a late failure of an earlier send changes nothing.
- A send that may have been billed (a 5xx, a timeout, a dropped connection, a 202 without a request id, a send cut off
  by a restart) is never sent again: it stays `submitted`, marked `maybe_billed`, for its webhook. A failure webhook
  fails it; unanswered for a day, it is `failed`. Without a webhook nothing answers it, so it fails after that day.
- Every change of a submitted job names the send it read (`request_sent_at`, `onSend`): a reconcile or webhook that
  read an older send (a reconcile still in flight when the webhook lands) changes nothing.
- `failed` is for what never transcribes: a refusal of the audio (another 4xx), audio missing from the audio store, three
  failed attempts, or a send that may have been billed and failed or was never answered. Its pages stay its own
  (`GET …/blocks` lists them), so nothing buys them again; a transcript that still arrives completes it.
- `invalid_audio` is the exception: unreadable audio stays unreadable. The job completes with an empty transcript
  and 0 billable seconds, its error noting "kept as a gap".
- A webhook without a readable transcript is kept on the job; the tick fetches the transcript by its id. A webhook
  naming no job is recorded by its type and field names only.
- The tick (every 5 minutes) reads the credits, fetches submitted jobs by their transcription id, then runs the
  worker. `completed_at` is set when the transcript is stored.
- Completing a job, whichever path brings the transcript (the send's answer, a webhook, the tick), is one function
  (`complete`): its transcript and turns in one transaction, its source grouped again from the block's start
  (`grouping.ts`), then what services.ts hangs on `onCompleted`: due chapters roll, the job's voices are cut and
  recognized, the phone gets a silent push, and the conversations' states and waiting reasons move
  (`conversation-state.ts`). The 5-minute sweeps only catch what a crash cut off. The credits the waiting reasons
  read are the worker's (`creditsOut`), the same ones that stop sends.

## Never buying twice

- A Pendant page is in one fragment and in one job that isn't failed. One process writes the SQLite file and a
  transaction runs to its end alone, so the check inside admission (`cutter.ts` `holderOf`) is the guard; a test
  admits overlapping blocks at once and only one wins. A fragment over pages a
  job (failed or not) or another fragment holds is refused with 409 `held`, nothing kept, and the phone renders again
  around `GET …/blocks`. The same pages and audio answer the same fragment, so an upload sent again buys nothing; the
  phone treats any 2xx as uploaded. A job's pages are its fragments', taken in its admitting transaction, which rolls
  back if any was taken meanwhile.
- A unique index on the audio hash plus settings keeps one job per audio, old jobs included.
- Each fragment is judged on its own when its block closes (`bought`): audio a completed or submitted job already
  bought (its map's segments, by more than 2 s) is covered, its audio deleted unread and its pages held. An old job the
  cutover left without pages is never bought again (`sources.handed_over_at`); the source's own jobs since its handover
  are judged by pages alone. Audio that starts before the Mac's first quiet range (`QUIET_RANGES_FROM`,
  2026-10-10 07:14 UTC) is covered too: no range hides the dictation it may hold.
- Dictation never reaches ElevenLabs, checked twice on purpose. The cutter reads no fragment of a block that ends past
  where the Mac vouches (`vouchedThrough` in `mac-socket.ts`), and withdraws a fragment a stored quiet range touches
  (the Mac's dictation, the phone's playback): its row and audio go, and the feed lists it as a removed job with its
  first page, so the phone sends those pages again without the range. The worker's `claim`, the one way to
  ElevenLabs, checks the same again: a job past the Mac's mark waits queued, and a queued job a range touches (one
  that came after its block closed) is withdrawn with its fragments. The first check costs one fragment, the second
  the whole job. Every state the Mac sends starts the worker.

## ElevenLabs' credits

Once the plan's credits are used up, ElevenLabs still answers 202 to an upload but never transcribes it: every upload
after that is lost. The server reads the credits every 5
minutes (`/v1/user/subscription`). Used up, nothing is sent: jobs wait queued. The owner gets an email when less than
20 % is left and when they run out, at most once per 12 hours each. `GET /status` shows them under
`transcription.quota`.

## Keyterms

- No limits: every admitted job goes. The transcription switch and the credits still stop sends.
- A block's keyterms are the owner's vocabulary (`PUT /vocabulary`, the whole list; the feed's `vocabulary` reads it), then every person's name
  and aliases, at most 100.

## Latency

`GET /status` shows `transcription.latency`: over the blocks completed in the last day, the median and 90th
percentile seconds from the block's last speech (`capture_end`) to its upload (`created_at`), and from the upload to
its words (`completed_at`). Beside it, the seconds from a chapter's end to its first summary (`docs/processing.md`).

## The pipeline

The Mac host polls `GET /status/live` every 30 s (the device token only, not a reader's): `pipeline`, `backup`,
`mac`, `pendant`, `phoneHeartbeat`, `transcription.quota` and `switches`, a few small queries. Its full status window
calls `GET /status` on demand: the same, plus the scans of the last day (the archive's invariants, latency, chain
steps, problems). `fixtures/wire/status-live.json` is its shape. `pipeline` holds:

- `transcription.waiting`: queued jobs (`blocks`) and the audio seconds they hold; `atProvider`: submitted jobs and
  the oldest send; `fragments.seconds`: speech uploaded whose block is still open; `failedLast24h`; `lastTranscriptAt`,
  the latest job completed.
- `ai.running`: the runs in flight, with the conversation's title (the owner's, else the summary's); `waiting`: the
  conversations whose summary is due or waits, as the rolling drain last found them (`rolling.ts` `due`; the rule is
  `summaries.ts`'s), the running ones aside; `blockedBy`: `aiOff` or `macAway`, the reason
  `conversation-state.ts` gives; `lastSummaryAt`, the latest valid run. The drain works out what is due every tick,
  the Mac away or not, so the count holds while it is away.

## Spending

`GET /usage/summary` adds up what was spent, per day in the owner's zone, from our own ledgers at
list prices: transcription (billable hours of every job that is not `failed`, keyterms counted at their extra price), titles and summaries (the
token cost on each intelligence run) and search embeddings. Jobs marked `maybe_billed` count. Days and months are the owner's, in
the time zone of the iPhone's latest heartbeat (UTC until one names it). Prices live in `apps/voice/src/config.ts`.

Beside it, ElevenLabs' own speech-to-text figure for the month, from its workspace analytics
(`POST /v1/workspace/analytics/query/usage-by-product-over-time`, product `STT`). That covers the
whole workspace, every key and app, so it can be higher than ours. It is left out when ElevenLabs
doesn't answer.

## Running the server

The server runs on the owner's Mac, inside Lifelog Host (`apps/dictation/README.md`, "Lifelog Host"): one binary, the
SQLite file and the audio folder under `~/Library/Application Support/lifelog`, listening on 127.0.0.1 only. Phones
reach it through the owner's tailnet (Tailscale Serve) or a Cloudflare tunnel to their own domain.

- `bun run --cwd apps/voice build:host [out]` writes `lifelog-server`, one file with its migrations inside; it needs
  no Bun or checkout, and migrates its file at boot. `bun run host:app` puts it in the app.
- One process writes the file: the server holds `<file>.lock` and a second one exits before it migrates.
- Variables are `Env` in `apps/voice/src/config.ts`; `apps/voice/.env.example` lists them. Host sets the archive's
  paths, the token hashes, the keys, restic and the identity service; anything else (APNs, Resend, `AUTH_SECRET`,
  the webhook) goes in `server.env` beside the archive, mode 0600.
- Mint the device token with `bun run --cwd apps/voice mint-token`; with `PUBLIC_BASE_URL` set it also prints the
  phone's pairing link. Host mints its own tokens and shows the link as a QR code.
- For development, `bun run --cwd apps/voice dev` runs it from a checkout with `apps/voice/.env`.

### The ElevenLabs webhook

A server the internet can reach can take an ElevenLabs "Transcription completed" webhook at
`<PUBLIC_BASE_URL>/webhooks/elevenlabs`, with its secret in `ELEVENLABS_WEBHOOK_SECRET` (and `ELEVENLABS_WEBHOOK_ID` to
send results to that webhook only). A server on a tailnet leaves it unset: each send then waits for its transcript in
the answer, and the webhook route refuses everything. A restart or sleep during that wait (seconds for a block) leaves
the send maybe billed and its block never transcribed, so restart between sends.

### Speaker recognition

`apps/speech` (`docs/providers.md`) is optional: without `IDENTITY_URL` and `IDENTITY_SECRET` the server recognizes
no speakers and everything else works. Lifelog Host installs and runs it itself, on loopback, and sets both (on by
default; `apps/dictation/README.md`). Elsewhere run it where the server can reach it (its Dockerfile, or `uv run
python app.py`), with the same `IDENTITY_SECRET` on both. `GET /status/live` says under `identity` whether it is set
up and how it last answered (`lastOkAt`, `lastError`); the server never probes it per poll.

### Export, import and restic

- `lifelog-server export <folder>` writes `archive.sqlite` (a `VACUUM INTO` copy, seconds even for a large archive),
  `AUDIO_DIR`'s files under `audio/` (not `.part` files, not `archive/`), and `manifest.json` (`format: 1`, each
  file's size and sha256, each table's rows). It refuses a folder with anything in it, and runs while the server does.
- `lifelog-server import <folder>` needs the server stopped (it takes the archive's lock). It refuses an archive with
  conversations or jobs, or audio in `AUDIO_DIR` other than the export's own, checks every file against the manifest
  before writing, copies beside (`*.importing`), checks the archive's rows against the manifest's counts, migrates
  it, rebuilds its keyword index, then moves both in, the archive last. On any error nothing was changed. If it
  crashed between the two moves, run it again: it takes the audio already there when every file matches the manifest.
- Both print one JSON line, `{ ok, files, bytes }`, or `{ ok: false, error }` with exit code 1.
- With `RESTIC_REPOSITORY`, `RESTIC_PASSWORD` and `RESTIC_BINARY` (restic ≥ 0.17; Host bundles 0.19.1) set, the
  daily copy is a restic snapshot of an export (`restic.ts`), staged in `restic-staging/` beside the archive and
  removed after, tagged `daily` from host `lifelog`. The repository is made the first time (exit 10, or restic's
  words for no repository). On Sundays by the Mac's clock: `forget --keep-daily 14 --keep-weekly 8 --keep-monthly 24
  --prune`, then `check --read-data-subset=5%`. Three tries a local day at most, an hour apart. A snapshot restic
  saved without some file (exit 3) counts, and its error says it is incomplete. `GET /status` `backup.restic` gives
  the last snapshot and the last error; never the repository or the password (readers see `/status`).
- To restore: `restic restore latest --target <dir>`, then `lifelog-server import <dir>/…/restic-staging` into an
  empty install (`apps/dictation/README.md`, "Restoring a backup").

### A restore from a daily copy

Without restic, the server copies its file once a day into the audio store (`archive/<date>-<sha>.sqlite`, the last
7 dates). To go back to one, stop the server, put it beside the archive under a new name, rebuild its keyword index
(`sqlite3 <file> "insert into search_text(search_text) values ('rebuild')"`: a `VACUUM INTO` copy may renumber the
passages, which `search_text` follows) and point `DATABASE_PATH` at it. The phone's and readers' cursors are then
past the archive's last change, so the feed starts them over from the beginning instead of skipping
(`routes/sync.ts`).

### Reading the archive

Open it read-only, never write it: `sqlite3 -readonly "$HOME/Library/Application Support/lifelog/archive.sqlite"`.
The server's scripts take the same path: `DATABASE_PATH=<that path> bun run --cwd apps/voice check:archive` (the
archive's invariants) or `diagnostics:recent [days] [--json]` (crashes and errors); both open it read-only.
