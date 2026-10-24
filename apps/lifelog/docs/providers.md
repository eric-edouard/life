# Providers

Which outside services see what, and what we keep. Transcription (ElevenLabs) is described in
`docs/transcription-server.md`; the speech service's share of it (`transcriber` `speech`) in
`docs/processing.md`, "Who transcribes".

## Speaker recognition: our own service, no third party

Voices are recognized by `apps/identity`, the speech service, which you run yourself. It wraps SpeechBrain's ECAPA
model (`speechbrain/spkrec-ecapa-voxceleb`, pinned to one revision), beside the transcription models (Nemotron 3,
VoxLingua107, Parakeet Ultra). No outside provider sees audio or embeddings for recognition.

**Flow**

1. After a transcript is ready, the server cuts the clean turns (at least 1.5 s, not overlapping another
   speaker) from the job's own Ogg Opus in the audio store: the time ranges of every clean turn, each at most 30 s. The
   Ogg and the ranges go once to the identity service (`POST /embed-ranges`) with a shared secret, which answers one 192-number embedding per range. Jobs from before the audio store have no audio to cut
   until the phone backfills it; the samples the phone sent before the rebuild stay, and it sends none now. The server
   cuts only the turns without one.
2. The server stores the embeddings.
3. Recognition compares each speaker (8 s of clean speech or more) with the people the owner named.
   A match needs a high enough score and a clear lead over the next person; otherwise "unknown".

**What is stored where**

| Data | Where | How long |
| --- | --- | --- |
| Job audio (Ogg Opus) | The audio store (`audio-store.ts`), kept for transcription | Sent to the identity service in one request, which keeps none: its memory only, never disk, a bucket or logs |
| Embeddings, with conversation, turn, speaker label, model, revision and time | Server database (`voice_samples`) | 30 days unless they are someone's evidence (a retired job's after a day, the owner's media at once); evidence is kept |
| Voice profiles: which embeddings are evidence for which person | Server database (`voice_profiles`) | Until the owner corrects them (an answer moves a scope's evidence; a merge moves it all) |
| People, speaker assignments | Server database | Kept |

**Rules**

- Only the owner creates people and adds evidence (naming, assigning or correcting a speaker or a
  single turn). Recognition never adds to a profile and never creates a person.
- Recurring unnamed voices may be grouped as candidates; they are never shown as people.
- A speaker or turn the owner marks as media (a video, TV, radio) has no person and adds no
  evidence; any evidence it had is removed. Recognition leaves it alone.
- Embeddings are biometric data. They stay on our server and are not sent to any provider.

**Running it**

- Lifelog Host installs it and runs it on `127.0.0.1` with its own secret, unless Settings turns it off.
- Elsewhere build `apps/identity/Dockerfile`, or run it with `uv` (`apps/identity/AGENTS.md`), on a host the server
  reaches. On it set `IDENTITY_SECRET` (a long random string), `PORT` (8000 by default) and, to listen on one address
  only, `HOST` (every address by default).
- On the server set `IDENTITY_URL` (for example `http://127.0.0.1:8000`) and the same `IDENTITY_SECRET`, in
  `server.env`. Without them the server cuts nothing, everything else keeps working, and its status says
  speaker recognition is off.
- The models (about 3 GB on a server, 1.8 GB with MLX on a Mac; every revision pinned) go in a volume at `/models`, fetched at the first start; the image
  build runs the contract tests, and the service runs its self-check at startup before it serves. It needs 4 GB of
  RAM with every model loaded (about 4.4 GB at its peak), and takes a block at a time.

## Titles and summaries: ChatGPT or Claude on the Mac

The server sends each model call to the Mac helper over its socket, and the helper runs
the selected CLI on the owner's subscription: Codex with `gpt-6.1-sol` and medium reasoning, or
Claude Code with `claude-sonnet-5-5`. Settings → Processing → AI model, or `bun run switches engine codex`,
selects it. A run keeps its engine through its calls and retries. Switching does not rerun completed summaries.
It costs nothing per call, but
counts against the plan's limits. When the Mac is away, asleep, signed out or at its limit,
runs wait. They start as soon as the Mac is back, and every 5 minutes after that. Nothing sends
them to a paid API.

**What is sent**, per call (a call is asked again up to twice when its answer is unusable; a roll sends only the
tail past the chapters already summarized, and the owner's Generate reads the conversation again from its first turn):

- the transcript text, turn by turn, each speaker a token (S1, S2…) with a legend: the owner, the owner's people by
  name, voices not identified yet,
- each turn's capture time, the recognizer's language codes and the owner's title, if any.
- the names of the owner's people (to say whether an unnamed speaker is one of them), and which one is the owner.

A roll reads the transcript twice: once for the chapters (a window of about 24,000 characters), then each closed
chapter's turns for its summary. The title and
TLDR are written from the chapter summaries alone. No audio, voice embeddings or locations.
Spoken instructions are sent as quoted data, and the model is told never to act on them.

**Retention**

| Provider | Model | Request settings | Their retention |
| --- | --- | --- | --- |
| ChatGPT Codex on the Mac | `gpt-6.1-sol` | Medium reasoning, ephemeral, dedicated login, no tools, rules, plugins or web | The consumer terms of the owner's ChatGPT subscription |
| Claude Code on the Mac | `claude-sonnet-5-5` | `claude -p`, no tools, settings or MCP, no session kept | The consumer terms of the owner's Claude subscription |

The server keeps every run: provider, model, reasoning effort, prompt version, raw output, validation errors,
tokens and a cost of 0 (`intelligence_runs`). Older runs from the paid OpenAI and Anthropic
APIs keep their provider and cost. Each new raw call also keeps its own provider, model and reasoning effort,
including retries. For historical raw calls without these fields, the containing run gives the provenance.
Reused chapters point to their source run.

Each call's JSON Schema is generated from the zod type the server reads the answer with
(`contract` in `intelligence.ts`): every key required, no other key, as Codex's strict mode
wants. An answer that isn't that JSON is unusable and asked again.

**Cost.** $0 a call on the selected subscription. An hour of talk is roughly 16,000 tokens of transcript.
Reading it twice, plus a chapter per ~4,000 tokens and the title, makes about 35,000 tokens in
and 2,000 out, which counts against the plan's limits.

## Places: Apple, on the phone

The phone takes a fix about every five minutes (latitude, longitude, accuracy, time) and names it as it takes it with
MapKit's reverse geocoding (`MKReverseGeocodingRequest`): free, no key, on the device. It asks Apple once per fix, in
English, and keeps Apple's short address or its city. The name travels with the fix to the server's location history
(`POST /location-history`, `placeName`). The server labels a conversation from its most accurate named fix, and a
long one with its place lines (`places.ts`). It never uses upload time as a place. No place provider is called.

## Search by meaning: OpenAI embeddings

Search on the phone matches words in its own index, offline. When the server is reachable it also
returns passages that mean the query without using its words, marked "by meaning".

**What is sent to OpenAI** (`text-embedding-3-large`, 1536 dimensions, with `OPENAI_API_KEY`):

- passage text: about 30 to 60 seconds of consecutive turns, with the names the owner gave
  speakers ("<name>: words"); unnamed speakers send their words only. Sent once per passage, and
  again only when its text changes (a transcript, a turn's speaker or a person's name).
- each search query the owner types (at least 3 characters, after a pause in typing). Identical
  queries reuse their embedding for 10 minutes.

No audio, voice embeddings, locations, capture times or titles.

**What we keep.** The passages, their embeddings (1536 numbers each), capture times, speaker
names and language in the server's database (`search_passages`). They are derived from the transcript and
rebuilt from it; there is no automatic expiry yet. Queries are not stored, only their token count
and cost (`embedding_calls`). Embeddings can be partly inverted back to text, so they get the same
care as the transcript.

**Retention at OpenAI.** The embeddings endpoint keeps no application state; abuse-monitoring logs
up to 30 days, no training on API data by default
([data controls](https://developers.openai.com/api/docs/guides/your-data)).

**Cost.** $0.13 per million tokens (`EMBEDDING_USD_PER_MTOK`). An hour of talk is roughly 10,000
tokens, about a tenth of a cent; a query costs nothing visible. It shows as Search in Spending.
Indexing a year of daily recording once costs a few dollars.

**Deploying.** Vectors are scored in the server's memory and keyword candidates come from an FTS5
trigram table; SQLite needs no extension. Without `OPENAI_API_KEY`, `POST /search` answers 503 and the app
searches by keyword only.

## Vocabulary: hints to ElevenLabs

The owner keeps a vocabulary: names, places and project terms. It is edited in Settings (Vocabulary) and kept on the
server as a flat list of spellings (`vocabulary`, `GET`/`PUT /vocabulary`, the whole list, through the outbox). The
spellings go to ElevenLabs as `keyterms` with each new block, and nowhere else.

- At most 100 spellings per request. ElevenLabs takes 1000, but more than 100 sets a 20-second minimum billable
  duration per request. Each spelling is under 50 characters, at most 5 words, without `< > { } [ ] \`.
- Keyterms cost extra per audio hour (`KEYTERMS_USD_PER_HOUR`), and the cost guard counts it.
- A block's keyterms are the vocabulary first (by spelling), then every person's name and aliases (name order),
  without repeats, up to the 100 (`blockKeyterms`). People are read when the block is admitted, and a block is the
  same job by its pages, so a new person never buys audio twice.
- A job carries the keyterms it was sent with. Changing the vocabulary only affects audio not yet sent; transcribed
  audio is never bought again.
- Hints never rewrite speech: the words stay as transcribed.

**Evaluating false insertions on the owner's clips (not done yet).** Pick about 30 short clips (1 to 3 minutes,
English, French and Thai): 15 where a vocabulary name is said, 15 where it is not but a similar-sounding word is.
Transcribe each twice through the server, with no keyterms and with the full vocabulary, against the owner's own
reference transcript. Count, per term, false insertions (the term appears with hints in a negative clip) and
recoveries (missing without hints, right with them). If false insertions stay common, keep the vocabulary off by
default or cut it to names only.

## Crash and health reports: our own server

No crash service. The app subscribes to MetricKit and sends what it delivers, plus a small
capture-health heartbeat, to our server (`POST /diagnostics`, `POST /health/heartbeat`, owner
token). Reports wait in a queue on the phone (`Library/Application Support/lifelog/outbox`) and are
retried with backoff; in Low Power Mode only crash reports and event heartbeats go.

**What is sent**

- Diagnostics: crashes, hangs, CPU and disk-write exceptions, with each call stack (binary name and
  UUID, address, offset), the app version and build, iOS version and device model. Never the
  Objective-C exception's message or arguments, or the memory-region description.
- Daily metrics: numbers only (foreground and background time, CPU time and instructions, peak memory, writes,
  exits, Wi-Fi and cellular bytes up and down, location time by accuracy, and the count, CPU and writes of the work
  the app marks with `mxSignpost` on its `work` log, such as each Pendant page's status update).
- Errors the app showed (`app_error`): where it was caught, the error's type and code, the HTTP
  status for a server error, a count per hour, the call stack, and the message cut to 300
  characters. The server's own 500s land in the same table (`server_error`), without request bodies.
  A network that gave no answer (offline, a timeout, a dropped connection) is not one: the connection status shows it.
- Heartbeat, at most every 6 h while the app runs, and at once when the Pendant connects or disconnects, when its
  recording changes (on, off, unknown), on a storage incident or a failed write, so `GET /status` shows the Pendant
  live: connection and recording state, last contact, backlog,
  sync phase, Pendant and phone battery, free space, background-wake counts, incident kinds, and how many
  Pendant messages were dropped since launch (a malformed fragment or one that didn't decode).

No audio, transcript text, names, places, coordinates or Bluetooth identifiers. Shortened error
messages are the one exception: they go only to the owner's own server. It keeps both tables 90
days. `diagnostics:recent` prints recent crashes, hangs and errors by signature, read-only on the archive:
`DATABASE_PATH=<the archive> bun run --cwd apps/lifelog/apps/server diagnostics:recent 1`.
Add `--json` after the days for one group per signature, with its ids, count, builds, app binary
UUIDs and first and last seen.

**Installing.** `bun run install:phone` builds `origin/main` (or `-- <commit>`) in a temporary
worktree, installs it on the iPhone and the Watch, and launches it. Before installing, it copies
every dSYM of the build to `~/Library/Application Support/lifelog/dsyms/<binary UUID>/`, with a
`build.json` naming the commit. That folder is outside every worktree, so it survives them.
`--no-install` only builds and keeps the dSYMs; `--no-watch` skips the Watch.

**Symbolicating.** Frames arrive unsymbolicated. `bun run symbolicate <diagnostic id>` reads the
diagnostic from `GET /diagnostics?id=` with the device token in `.env.device-token`, finds each
binary's dSYM by UUID in that store (then in `.build/dsyms`, `.build/device` and
`.build/DeviceDerivedData`), and runs `atos` on its frames. System frames stay binary+offset. It
says so when the app's dSYM is missing. Each heartbeat names the installed build
(`build.executableUUID`). Release builds are reproducible: rebuilding the same commit with
`bun run install:phone -- <commit> --no-install` gives the same UUIDs, so a lost dSYM can be
recovered when the commit is known.
