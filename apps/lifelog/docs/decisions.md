# Decisions

The choices that shape lifelog and why, as they stand now. Read the one you are about to reverse first; if you
reverse it, change its entry here in the same commit.

## Capture

- **Native iOS 27, logic in a Swift package.** SwiftUI, generated with XcodeGen. Anything that doesn't need UIKit or a
  device (protocol codec, page store, time maps, export formats) lives in `apps/ios/Kit`, so it builds and tests on
  the Mac in seconds. Swift 6, complete strict concurrency, warnings as errors.
- **The Pendant protocol comes from public sources** (Omi, pendant-cli, Limitless help), each fact marked verified or
  not in `docs/pendant.md`.
- **Raw pages: append-only packs plus SQLite receipts.** Bytes are appended to a pack and fsync'd with `F_FULLFSYNC`,
  then a receipt is committed (WAL, `fullfsync`). Decoding and speech analysis are a separate retryable queue that
  never blocks ACK.
- **ACK is a contiguous durable prefix.** ACK deletes every page at or below its index, so the app ACKs only the end
  of the unbroken run of durable or gapped pages, capped at what this drain itself stored. Omi's app ACKs the highest
  index seen, which can delete a page that never arrived; this app doesn't.
- **Receipts belong to a flash life.** Page indices restart after a clear or reset and a second Pendant reuses them,
  so a receipt vouches only for its life (serial and flash generation), and each life gets its own band of store
  indices. Conflicts and held pages wait for the owner.
- **Plain CoreBluetooth with state restoration, not AccessorySetupKit.** AccessorySetupKit would relaunch the app
  after a force-quit, but declaring it puts all of CoreBluetooth in its mode, so plain scanning stops working.
- **An Omi drains through the same pipeline**, with a known risk: released Omi firmware frees a record once it is
  delivered, before the phone stored it. The app warns on the Pendant screen and asks for an update once a firmware
  fixes it (`docs/research/omi.md`).
- **Watchdogs are stopgaps.** A capture run loop once stayed parked on an await for a night, and once the whole
  capture froze: `watchStall` drops a silent link and `FreezeWatch` crashes a frozen app so iOS relaunches it with a
  report of every thread (`docs/pendant.md`). When a report names the cause, fix it at its root and delete both.
- **Original capture time is the canonical timeline.** Every word, boundary and place is anchored to the Pendant's
  clock, corrected where measured. Uploaded audio has its own timeline and a time map back (`docs/timeline.md`).
- **Upload only speech, with no loudness gate.** A second goes up when Silero VAD or Apple's sound classifier hears
  speech, padded 1 s each side, cutting only gaps of 3 s or more. A loudness gate cut real phone calls; this rule
  sends about a third of the audio and keeps over 99% of the words.

## Server

- **The voice bench keeps its own answers and its own page (owner's choice, 10 Nov 2026).** What the owner answers
  in the bench's review goes to the bench's `answers.jsonl`, never to the archive: the bench reads the archive
  read-only, and his naming changes only in the app. Its page is a development tool the CLI serves on 127.0.0.1
  from the bench's private folder, not a page lifelog serves: no token, no tunnel, and its only writes are an
  answer and a new scoring, from its own origin.
- **A local voice map on the Mac (owner’s yes, 9 Nov 2026).** lifelog serves its first page at `/voices`,
  a static shell with vendored Plotly and no personal data. A scoped `map` token opens only `GET /speakers/map`,
  the queue’s existing audio and answer routes, and per-turn naming PUT only for (job, label, turn) triples
  in the current cached map's clips. Missing turn indices and triples outside it receive 403; device and corrections
  tokens retain their existing scope. The map reads the queue’s
  cards and words in their order, with the same likeness ranking as recognition; easy targets are cards above the
  candidate threshold.
  PCA projects people and queued unnamed group centroids separately for each embedding model and revision,
  cached for each incremental queue build. Named clouds read currently named turn samples through the shared
  assignment resolver, including owner evidence (solid) and recognition matches (hollow). Each person and model
  shows at most 400 samples, chosen by deterministic stride across recording time (sample creation time for legacy
  rows), on those same centroid-fitted axes. Point kinds are explicit; vectors never leave the server.
  Sidebar checkboxes toggle each person and unnamed voices, with All/None controls.
  Likeness is not a calibrated probability. Naming uses the queue’s answer route or scoped per-turn PUT.
  `bun run voices` keeps the map token in the Mac Keychain (`lifelog-map-token`), activates its hash in Host’s
  owner-only `server.env` and restarts its verified supervised server child only when that hash changes.
  Its restart probe requests the nil transcript UUID's audio and expects 404 without building the map.
  It opens a loopback link with the token in the fragment, never a query. The map routes are also
  reachable through the public tunnel with that token; the static shell contains no personal data.
  Life’s separate server still serves no page.
  Queue and map builds share linkage, clips, profiles and decoded samples. One read-only Bun Worker owns the
  incremental queue and projection, with revision and rows in one transaction: even shared builds exceeded the
  200 ms request-thread budget. Phone queue reads and the morning digest await that same snapshot through their
  request-start revision; speaker scope selects phone cards. Host compiles the worker, unreferenced and closed on exit.
  Map GET returns a shallow copy of the last completed snapshot while refreshing (`building`), or 202 initially.
  Completed snapshots publish despite concurrent writes; the next read refreshes, avoiding starvation. Polling
  preserves a Several people edit. Failed workers report diagnostics and settle waiting readers; phone queue reads
  reject snapshots behind the requested revision. A failed revision retries only after 30 seconds or a revision
  change. Scoped PUT checks the displayed map's clips. The worker never writes the archive.
  Synthetic fixture: 40,150 samples, 192 dimensions, 30 people, 2,000 cards and 2,575 points; timings bound this fixture.
  Timings (Bun 1.4.2): queue 17,795 → 3,251 ms; shared map 10,799 → 678 ms; worker cold/warm 4,106/~3,200 ms; maximum stall 10,804 → 39 ms.

- **Split mixed voices by turn before asking (owner's decision, 9 Nov 2026).** Recognition groups a label's sampled
  turns after removing the owner's turns. Distinct groups with enough speech get recognized turn rows; a split
  supplies neither a name nor evidence. Matching and nearby naming apply to every group. The largest group stays
  the label's only phone card; the map lists the others and names their turns through the existing PUT. The map also
  offers the phone's "Several people" answer: name clips first, then submit the existing answer. No phone change.
  A turn containing two voices needs re-cutting within the turn and is outside this change.

- **The server owns conversations; the phone captures.** One side owns each fact: the phone captures, places audio
  in capture time, labels speech and uploads; the server groups, transcribes, recognizes, summarizes and serves. The
  phone's library is a cache, and the owner's edits travel as intents (`docs/sync.md`). Two owners of the same fact
  disagreed.
- **The server keeps the audio and cuts the blocks.** The phone sends speech fragments of whole pages; the server
  keeps them and closes blocks of up to 2 minutes on its own clock, so a retry never needs the phone. The cutter is the
  only way a job is made (`docs/transcription-server.md`).
- **One SQLite file, one writer.** A transaction is a synchronous function that runs to its end alone, so the change
  log's order and the paid-once admission check hold without locks. Every query runs on the event loop: keep passes
  incremental.
- **Lifelog Host is the whole install.** The server, the Mac helper, Codex, `cloudflared` and `restic` run in one menu-bar
  app on the owner's Mac; audio stays on its disk; phones reach it on a tailnet or through a tunnel; backups are
  restic into iCloud Drive. The tunnel's token goes in cloudflared's environment, never its arguments, which `ps`
  shows. The backup password is minted once and never replaced: a new one would lock out every snapshot.
- **Secrets in a 0600 file, not the Keychain.** The Keychain trusts one binary, so every rebuild asked for a password
  and nothing ran until someone answered. The helper and Host share `secrets.json`.
- **Paid work happens once.** A page is in one fragment and one job that isn't failed; a send that may have been
  billed is never sent again; a new prompt version reaches new conversations, failed runs and the owner's Generate,
  never the whole archive. One exception, the owner's (29 Oct 2026): the speech blocks recorded in Thailand before
  the context router, where Thai was spotted but only parts went to Scribe (343, about 13 h), are heard by Scribe
  whole once more (a step since removed; `transcripts.scribe_words_at` marks them). Their words change turn by
  turn, never their turns: the owner's speaker names and the voice samples point at turns by index and label.
- **Transcription: the speech service, Scribe for the rest (23 Oct 2026).** The `transcriber` switch picks it:
  `speech` sends a block to `apps/identity` (Nemotron 3's speaker turns, VoxLingua107's language per turn, Parakeet
  Ultra's words, on MLX on the Mac), and only Thai turns go to ElevenLabs Scribe v2. The owner's goal (29 Oct 2026) is
  the best transcription in every language wherever he is. VoxLingua's top guess misses most short Thai (it hears Lao,
  Javanese, English and dozens more, and Parakeet writes made-up words), so a turn is routed by a small logistic model
  over VoxLingua's scores and the rest of the block, its weights fitted by `bench context fit` on blocks Scribe heard
  whole (seven numbers; no figure of a day or a block is committed). Where the owner is sets the bar, never the model:
  learned as a feature, place made Thai spoken elsewhere count as not Thai. On 310 blocks, scored on days the fit left
  out, it missed about 2% of Thai where Thai is spoken (11% for the 10% rule before it, 63% for the 70% rule before
  that), sending about half that speech to Scribe, and about a tenth of Thai elsewhere. A block goes to Scribe whole
  once half its judged seconds are routed (the owner's choice, 29 Oct 2026): at a tenth, as the rule before it, it missed 0.1% of Thai but sent 40% of
  English and French against 18%. The zone at the block's recording comes from lifelog's own heartbeats (kept 90
  days, `ownerZoneAt`), its one use of where the owner was. Until 24 Oct 2026, every turn
  neither English nor French or with no words went: VoxLingua tags short noisy French as other languages, and with
  credits out a whole morning waited. `scribe`
  (the default) sends every block to Scribe whole, as before. Parakeet Ultra was as close to Scribe on English and
  French as anything measured, and Nemotron closer on speakers than pyannote; no open model is good enough on Thai
  (`docs/research/transcription-bench.md`). Apple's and Whisper's transcription were rejected earlier for Thai and
  mixed audio.
- **Summaries on the owner's subscription, through the Mac.** ChatGPT (Codex) or Claude Code runs every model call
  with no tools, settings or MCP servers; when the Mac is away or at its limit, work waits. There is no paid API
  fallback.
- **Search by meaning runs on the Mac (5 Nov 2026).** EmbeddingGemma-300M under llama.cpp, a Lifelog Host child,
  replaces OpenAI's embeddings: better on the owner's languages, free and local. Life's memory uses the same embedder.
- **The Mac helper is a sensor and a runner (October 22).** It reports raw facts (the processes with the microphone on,
  sleep) and runs the CLI it is told to, reporting the raw output; which apps count as dictation, the padding,
  merging and limits, and what a CLI's output means, are the server's (`dictation.ts`, `mac-llm.ts`). So a helper for
  another platform is a thin port, and one rule has one copy. What must stay on the machine stays: the empty folder
  and no-tools flags (the server could otherwise run tools on the Mac), the outbox until acked, and the subscription
  readings, filtered to percentages before they leave.
- **Summaries cite their turns.** Both engines answer one strict JSON schema whose claims cite turn ids; output that
  fails the checks is kept as `invalid` and retried only on the owner's Generate. A run keeps each usable answer, so
  an interruption resumes instead of restarting. The owner's title always wins.
- **Speakers are tokens named when read.** The model writes `{S2}`; the server renders the person's name, else
  "Speaker N", so naming a voice later fixes every summary at no cost.
- **A thin phone's pages are labeled and cut on the server, by the iPhone's rules.** Silero VAD v6 runs on the
  official ONNX model (snakers4/silero-vad `v6.0`, `silero_vad_16k_op15.onnx`, MIT, in `apps/server/models`) in
  onnxruntime-web 1.30.0's WASM runtime, single-threaded; Opus decodes with opus-decoder 0.7.12 (libopus in WASM). Both
  run in a Bun Worker (`vad-worker.ts`, a second entrypoint of the compiled server), so the runtime's Emscripten globals
  stay out of the server's thread, and so does about 0.6 s of CPU per minute of audio (M-series Mac). Both are reached
  by their packages' own entry points; the compiled server embeds the runtime's WASM and glue (`build-host.ts`, by
  ORT's documented file names) and finds them by name, so it reads nothing beside it. `build-host.test.ts` proves the
  macOS binary labels pages and the Windows one compiles with them (nothing runs it on Windows yet). NOTICE, beside the
  binary and in Host's Resources, carries their licenses. Rejected: onnxruntime-node, a native addon beside a shared
  library that `bun build --compile` can't carry or cross-compile; a hand-written Silero in TypeScript, model code
  nobody else checks. On the fixture its probabilities are within 0.05 of Kit's Core ML model and its labels identical,
  in one batch or in batches of 100 pages. Apple's sound classifier has no portable equivalent and is left out: on a
  page source, speech is Silero's alone and audible the energy detector's, so grouping may split at a stretch only the
  classifier would have heard as noise. Fragments are the original Opus packets, not re-encoded as the iPhone does:
  no encoder to carry, no second loss, a few tens of ms at a stretch's edge rounded inward to whole packets, so nothing
  a quiet range covers is ever kept.
- **The server's VAD never hears dictation.** A page source is labeled only up to the Mac's watermark, and a packet a
  quiet range touches is never decoded: Silero hears silence there. The iPhone labels on the phone, which is the
  owner's own device; the server is not, so the rule holds with no exception for speech detection.
- **Dictation is stored, never processed.** The Mac helper reports when the owner dictates to the Mac; the ranges
  the server makes of it are cut from every job before ElevenLabs, `apps/identity` or a model sees it, checked in the cutter and again in the
  worker's `claim`. The raw backup holds everything the Pendant heard. One exception: a press of the Pendant's button
  sends the last minute as it is, because the owner is sending his own words to his own tools.

## People, places and search

- **Speaker recognition is self-hosted.** SpeechBrain ECAPA on a small CPU service, so voices and embeddings never
  reach a third party. Only owner assignments add voice evidence; a voice match needs a score and a lead over the
  runner-up, else unknown. Context naming and inferred creation follow the decisions below. On the Mac, Lifelog Host installs it with a pinned `uv` from the bundled lock and
  supervises it like its other processes: production lost naming for a day when it was a separate thing to start.
- **Autonomous speaker naming from context and voice likeness** (owner's decision, 10 Nov 2026).
  This supersedes owner-only naming and creation above. A validated context reading may name a checked
  turn scope as `source: inferred`: what the model guessed and uses until corrected, never voice evidence.
  Qualifying voice matches and owner answers win; inferred names supply neither profiles nor nearby references.
- **Dropped the owner-plus-one shortcut** (owner's decision, 10 Nov 2026).
  "I don't think it's a good rule. There can be background music, they can be people saying things in the background, so not great."
  Context and voice likeness still name checked turns; no conversation-size premise names the remaining turns.
- **Automatically add Life people “when confident”** (owner's decision, 10 Nov 2026).
  This supersedes the no-background-write rule below for Life's authenticated complete people snapshot and
  the automatic-merge ban for canonical Life folds only. A fold retargets a link or uses the existing merge
  transaction, preserving owner attribution and evidence; nearby naming never merges. Inferred creation
  provenance is separate from attribution. Conflicting owner links or rejections block an automatic fold.
  None of these decisions authorizes overwriting owner answers, reprocessing speech or summaries, a model
  backfill, or an archive naming run. Calibration, a held-out gate, the capped pilot and separate archive-run
  authorization must precede archive writes.
- One list of voices to name covers the whole history (owner's decision, 9 Nov 2026). Exact average linkage uses
  group vector sums and counts instead of an all-pairs matrix before the sample set grows. Cards with playback come
  first, then by the words a name unlocks; overheard groups with at least 300 words are eligible. Brief strangers and
  media are left out. Clips are built only for returned cards (`docs/processing.md`, "Speakers").
- Unnamed samples no longer expire by age (owner's decision, 9 Nov 2026). This replaces the previous promise to delete
  voice data that was nobody's evidence after a month. Samples stay until named or rejected; strangers' samples
  remain negative references. An unnamed or several-person voice is still nobody's evidence. Only clips attributed
  by the owner become person evidence; retention grants no permission to send embeddings outside the server.
- Old voices recover through the existing sampler (owner's decision, 9 Nov 2026). One database migration reopens
  conversation-held jobs with stored audio. The sampler alone decides eligibility, preserves existing samples and
  owner assignments, retries least recently attempted jobs first and permits only one pending pass at a time.
  Dictation and unsafe old audio remain excluded; recovery never transcribes again.
- Split voices use the existing nearby naming path (owner's decision, 9 Nov 2026). References cover the whole
  conversation and the job's own direct matches, with the measured thresholds unchanged. No chaining, nearby-driven
  person merge or new evidence: the owner's assignments win. For a lone profile, `rankPeople` scores the missing runner at 0.6 (confirming review, 9 Nov);
  no caller bypasses it. A 0.65 voice fails ordinary, candidate and nearby profile naming; a 0.55 owner
  short turn fails its margin. Owner turns at 0.65 still match through the existing 0.6 owner threshold.
  Current `origin/main` (30d9002d) uses zero and names the 0.62 borderline case; its null regression
  expectation and incident comment were restored from the last review commit's parent (3741c5f3).
  Offline `bun apps/lifelog/apps/server/scripts/eval-voices.ts --check` passed: 4,146 turns, all baseline
  counts unchanged; no answers or baseline rewritten. This replay excludes nearby naming and candidate sets,
  which are covered by synthetic regressions.
- **"Not anyone I know" is a stranger the owner doesn't care about** (the owner's words, 3 Nov 2026). A voice that
  sounds more like those than like anyone named is a stranger too (status `stranger`): never named, grouped,
  recovered or asked about. Its samples remain negative references.
- **Places come from the phone's fixes and Apple's names**, on the device and free. No Google, no saved places. The
  server keeps the whole location history, behind the same auth as everything else.
- **Search: keywords on the phone, meaning on the server.** The phone's trigram index always works offline; the
  server adds passages found by meaning and by every word typed, the two rankings fused: a passage both find
  outranks one only one finds.

## Readers and glances

- **Readers use a contract, not the phone's API.** A reader such as Life follows the feed with its own `read` or
  `corrections` token. Life alone may push its authenticated people snapshot and request the naming pass
  in the background; lifelog never calls Life (`docs/voice-source.md`).
- **lifelog signs no tokens for readers.** Its OAuth issuer (`packages/auth`, Better Auth) signed Life's tokens until
  24 Oct 2026; Life now signs its own (Life's `oauth.ts`, approved by a pairing code on the Mac), so the issuer, its
  pages, `AUTH_SECRET`, `LIFE_URL` and the `auth_*` tables went. A reader reaches lifelog only with its own `read` or
  `corrections` token.
- **Events trace each chain.** Every step the owner relies on (pushes, the Mac socket, quiet ranges, uploads,
  ElevenLabs, what the phone saw) is an event of ids, states, counts and status codes, kept 14 days; `bun run events`
  reads them in time order beside the Mac helper's log.
- **Widgets, controls and the Watch read one snapshot** of the Pendant's last reports with their times, and each
  decides freshness when it reads, so a glance turns to "last known" on its own.
- **A pause holds while the link that confirmed it is up.** A paused Pendant sends nothing, so the usual 6-minute
  freshness would turn it to "last known"; but a pause ends only by a press or a command, and either pushes a status
  on the same link. Recording keeps the 6-minute rule: the firmware can stop on its own.
- **Face buttons try the background, then open the Watch app.** A Watch face button's intent runs in the Watch app
  (`allowedExecutionTargets`), tries the phone for 2 seconds in the background, then brings the app forward. Going
  through the server doesn't help: background pushes are throttled and dropped after a force-quit.
- **Only the Pendant's own changes notify.** A pause or resume the app asked for stays quiet; a lost link waits ten
  minutes before it says so.
- **The Pendant's button asks an AI.** One press transcribes the last minute at once and offers it to Claude or
  ChatGPT; nothing of it is stored on the server but its cost.

## The repo

- **Better-T-Stack's layout, with lifelog's own tools.** The owner's platforms plan (22 Oct 2026) ran
  `bun create better-t-stack@latest lifelog --frontend none --backend hono --runtime bun --database sqlite --orm drizzle
  --api none --auth better-auth --payments none --addons turborepo biome ultracite skills --examples none --db-setup none
  --web-deploy none --server-deploy none --no-git --package-manager bun --no-install` (3.47.0) into a scratch folder,
  and the repo moved into its shape: `apps/server` (Hono), `packages/db` (Drizzle, SQLite), `packages/auth` (Better
  Auth, as it already was), `packages/config`, a Bun workspace with a catalog (every version two packages share),
  Turborepo, Biome with Ultracite and the skills lock. The native apps stay in `apps/`. Left out of the skeleton:
  varlock (`config.ts` validates the environment with Zod), tsdown (the server ships as `bun build --compile`), libsql
  and Drizzle 1.0's release candidate (the archive is `bun:sqlite`, synchronous on purpose), `bunfig.toml`'s
  `env = false` (the server reads `apps/server/.env` in development), a hoisted install (nothing runs a binary from
  `node_modules`: Host downloads its helpers pinned) and `bts.jsonc` (this entry keeps the command).
- **Clients are generated at build time, never committed.** The Android app's `api/` module is generated
  from the whole contract (OpenAPI Generator; tuples read as JSON), so a contract change needs only a rebuild. Plan of
  record: the iPhone moves Kit's hand-written `ServerAPI` onto a generated Swift client (Apple's
  swift-openapi-generator) in one PR, so the client lands with its first caller. That generator drops a nullable
  property (`anyOf` with `type: null`, apple/swift-openapi-generator#817); the PR handles it or waits for the fix.
