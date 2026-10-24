# Processing

What happens to the Pendant's audio after capture. The server does most of it: it keeps the audio, transcribes it,
groups it into conversations, recognizes speakers and summarizes chapters. The phone's part is short: it labels
speech and uploads it as fragments; the server cuts the blocks. Who owns what between them: [`docs/sync.md`](sync.md).

## On the phone

One run (`Driver` in Kit; `SyncStore` in the app starts it) goes after each Bluetooth sync that saved audio (in a
Bluetooth wake too), on the server's silent push, in a background processing task, when the app comes forward and
when the network returns. A run cut short loses nothing: the next resumes. Capture never waits for it. In order:

1. **Derived audio.** `DerivedAudioWorker` decodes new pages into playback files and labels each second (Silero,
   Apple's sound classifier). It rests while the phone is hot. A job is timed by the clock from its first page on
   (the last anchor before it and those after), not by every sync ever. Each file's sidecar goes to the timeline's
   index before the job completes: a crash in between runs the job again, and it hands its finished files again, so
   nothing lists the derived directory. Once a day, playback files whose audio ended over a week ago are deleted to
   save space; their labels stay, and playing or exporting such audio encodes the file again from the source packs
   first.
2. **The timeline.** `TimelineScanner.scan()` reads new pages (in the order they were stored, so a page filling a hole
   below pages already scanned still counts), gaps, clock syncs and pauses into spans in `timeline.sqlite`, and notes
   from where timeline facts changed (the labels came in with step 1).
3. **The owner's edits** (`Outbox.replay`), in the order made, each made into its request as it is sent, before any
   upload, so an edit never waits behind a backlog.
4. **The feed** into the library's cache, page after page, before any upload: the fragments then leave out the
   newest quiet ranges, and the cursor moves back for the fragments the server withdrew. A pull that fails doesn't
   hold uploads back: they go with the quiet ranges the cache has, then the run stops. In the foreground it is then
   long-polled.
5. **Uploads** (`Uploader`). Speech fragments first: the kept speech of whole pages from the cursor on, rendered to
   Ogg Opus 16 kHz and put once (`PUT /sources/{id}/speech/{firstPage}`). The server joins them into blocks and
   decides when a block closes (`cutter.ts`). Where a fragment ends (`SpeechFragment.next`), within 90 s of speech:
   at the last pause, a page's end outside kept audio with speech after it or heard-through past it, so speech still
   going on waits and seams fall in silence; with no pause and a minute waiting, inside the latest second the
   analyzers call non-speech; with neither, at 90 s. Then timeline facts (`FactsBuilder`,
   [`docs/timeline.md`](timeline.md)), with `heardThrough` and `sentThrough`: where the first kept second not sent
   starts, or heard-through when none waits. The server closes blocks on it.

   One rule decides what goes up: kept speech on every page the server doesn't hold, across the whole archive, read
   an hour of capture at a time. The phone keeps one cursor in `upload.sqlite`: below it every page is with the
   server or has nothing to send. Past it, the server's pages (`GET /sources/{id}/blocks`: jobs and fragments, old
   parts' pages the cutover gave included) are taken out with their audio (`SpeechFragment.unheld`); they are read
   when the cursor moves back or a fragment is refused. The cursor moves back for a page stored below it (a late
   drain, a held page repaired) and for a fragment the feed says the server withdrew (the feed's row carries its
   first page). A page goes in one fragment: a 409 `held` reads the server's pages and renders again without
   them, and the same pages and audio sent again answer the same fragment, so a crash before the cursor is saved buys
   nothing twice. Any 2xx moves the cursor. Another refusal, or an outage, waits 30 s, doubling to an hour, and the
   status sheet says why (`upload.failed`). A fragment the server refuses for itself (a 4xx but 408, 429 or `held`),
   or that can't be rendered, is skipped after three tries (`upload.skipped`, its pages), so the speech after it goes;
   a 5xx never is. Offline stops the run. No render starts after a minute in a run, so the edits and the feed never
   wait long behind a backlog; in the background each render is followed by a rest as long as it took, about half a
   core. `upload.sqlite` stays out of iCloud backups: after a restore or on a new phone, as after a reinstall, the cursor
   starts at the page holding the source's `sentThrough`, around the server's pages. Speech from before the cutover that no old part holds goes up this way; the
   server covers audio bought already or from before the Mac's first quiet range (`QUIET_RANGES_FROM`).

   `heardThrough` is the capture time up to which every page is on the phone: stored, a recorded gap, or held (an
   undecodable page kept for the owner), so a held page never stops uploads (`PageSink.savedIndex`; ACK still stops
   there). It comes from the Pendant's last status that had nothing more to send, less 3 s
   (`FactsBuilder.savedThrough`): the page being written holds 1.5 s of audio (1.64 s at the 99th percentile), and a
   sealed page reaches the phone 77 ms to 0.5 s after the next one opens, never before (measured over 44k pages), so the
   Pendant's clock is within a fraction of a second of the phone's. Speech still going on always reaches
   heard-through, so it never ends a fragment. It runs at most 10 minutes past the newest stored audio (`FactsBuilder.quietAllowanceMillis`): the Pendant stores
   nothing in silence, so a quiet stretch still counts as heard, but a phone clock that jumps forward can't carry
   heard-through, which never moves back, far ahead.
6. **The location history**, in batches of 500.
7. **The raw backup** (`Uploader.backUp`), on Wi-Fi or power: the day's `source.sqlite` snapshot, sealed packs, and
   the audio of old jobs. It is not a step of the run: it goes in its own lane beside the runs, so new speech never
   waits behind an item (`docs/sync.md`, `docs/formats.md`).

What never reaches ElevenLabs:

- **Dictation to the Mac.** The Mac's quiet ranges, read from the feed's rows in the cache, are cut out of fragments.
  Which apps count is the server's list (`dictation.ts`): Mac bundle ids, with their helper processes, and Windows
  images (`*.exe`, any case) from their own table. When unsure whether an app is voice input, it is on the list:
  matching too much only holds audio back, matching too little sends dictation to be processed.
  The phone doesn't wait for the Mac, so a dictation it hasn't reported yet can be in a fragment. The server joins no
  fragment until the Mac vouches for its block's end (its watermark, `docs/sync.md`), and its job worker is still the
  gate to ElevenLabs (`jobs.ts` `claim`). A fragment a range touches is withdrawn unread, its audio leaves the audio store,
  and the feed says it went (`removed`, kind `job`, the fragment's id); the phone moves its cursor back and sends those
  pages again with the range cut out. Every word from the Mac (and every range its events close) starts the worker, so a
  block held for the Mac goes as soon as it vouches. It shows `macAway` while a refused event blocks it. The raw packs and the fragments waiting for
  their block do hold the dictation: they are stored, never processed.
- **Recordings the app plays out loud** (speaker, AirPlay, a car or a Bluetooth speaker; not headphones, told from
  Bluetooth speakers by name only): the phone stores the span, padded 2 seconds and stored again every 30 s while it
  plays, as a quiet range of its own, and cuts it out of fragments. Once closed, the span goes to the server through the
  outbox, in pieces, so words already bought inside it are hidden there too.

## On the server

Details of each step are in [`docs/transcription-server.md`](transcription-server.md) (blocks, jobs, cost) and
[`docs/timeline.md`](timeline.md) (grouping). In short:

1. **Fragments stored, blocks cut, a job created.** Each fragment goes to the audio store. The server closes a source's
   open fragments into a block itself (`cutter.ts`): at 2 minutes of speech, on a pause of 5 s the phone saw
   (`sentThrough`) once it holds a minute, or 30 s after its last speech with nothing kept since, by its own clock. A
   closed block waits for the Mac's word; a fragment bought already is covered (its audio leaves, its pages stay
   held) and one a quiet range touches withdrawn (its audio leaves, the phone sends its pages again); the other
   fragments are joined into one job, `queued`. A block that fails three times (`block.failed`) is withdrawn too. The
   worker's `claim` checks the Mac and the quiet ranges again before it sends: a range that came after the block
   closed withdraws the whole job.
2. **The worker sends it** to ElevenLabs from the audio store, with retries, and stores the transcript when the send's answer,
   the webhook or the 5-minute tick brings it.
3. **Turns.** Each transcript becomes turns in capture time (`turns`), through the job's time map. A conversation's
   words are the turns that start inside its range; dictation and media are hidden in one place (`keptWords`).
4. **Grouping** for the source runs over the block's range, forward-only (`docs/timeline.md`). Conversations change
   in the feed.
5. **Speakers** are recognized from the job's own audio (below).
6. **Summaries** roll for every conversation whose words changed (below).
7. **Waiting reasons** are written on each live conversation and logged when they change.

### Latency

Targets, while the Pendant is connected and the phone online: speech to words about 5 minutes or
less; a chapter that closes to its summary about 5 minutes with the Mac up; every wait has a reason. `GET /status`
shows what happened over the last day, as the median and 90th percentile: seconds from a block's last speech to its
upload, from its upload to its words, and from a chapter's end to its first summary. The phone uploads at each
Bluetooth sync and when the app comes forward. While the latest heartbeat says the Pendant records and the Pendant's
heard-through is more than 5 minutes behind, the 5-minute tick sends the phone a silent push to send what is ready
(`askForUploads`, `ready: "upload"`), so at most one every 5 minutes. Only the iPhone's sources count: a raw-page
source's heard-through is the server's own and never hides the iPhone's lag. If it is behind by more than the owner's delay
(Settings, Alerts: Off, 10, 15 by default, 30 or 60 minutes), the same check sends one visible alert, "Open lifelog"
(`ready: "open"`). Tapping it opens the app, which uploads as it comes forward. It goes once per episode: only the tick
that first finds the delay passed sends it, so a deploy in that 5-minute window skips it.

"The Pendant records" has one rule on the server (`pendantRecording`): the heartbeat's last confirmed state
(`recording.lastKnown`), else its current one. The phone keeps the last confirmed state across a lost link, while the
current one turns `unknown` until the Pendant reports again. The Pendant keeps recording to its flash while it is out of
reach, and its audio comes once the link is back. So the push keeps going, a stalled conversation keeps waiting on the
phone (`phoneQuiet`), and `GET /status` keeps saying it records. The last confirmed state has no age limit: a Pendant
whose battery died keeps the push going until the phone's app restarts. The phone sends a heartbeat when this value changes (`HeartbeatSchedule`), so the two change together.

### Waiting reasons

A conversation that isn't finished says why in the feed (`waiting.reason`, `since`), and the app says it as a
sentence. While a job over it isn't completed, the reason is `transcriptionOff` or `creditsOut`. Otherwise, `macAway` while a refused event blocks the Mac's
watermark (`docs/sync.md`), `phoneQuiet`
when heard-through is more than 10 minutes behind and before the conversation's end while the Pendant records (audio of
it the phone hasn't sent), and, for a conversation with words that is still open or due (Summaries, below), `aiOff`
or `macAway` (its summary waits for the Mac).

### Pausing transcription and AI

Two switches, in Settings under Processing, or from the Mac:

```bash
bun run switches                      # what they are now
bun run switches transcription off    # transcription | ai | all, on | off
```

- **Transcription** covers audio to ElevenLabs and voices to `apps/identity`. Off, blocks still go up and wait on the
  server (`waiting.reason` `transcriptionOff`). Jobs already with ElevenLabs still finish and come back.
- **AI** covers summaries, titles and chapters on the Mac, and search embeddings. Off, runs wait
  (`aiOff`). Search answers `search_unavailable`, so the app searches its own cache only.

The server keeps both in one row (`processing_switches`) and checks them before every call. The phone reads them in
the feed and sets them through the outbox (`PUT /switches`), like any edit. Turned back on, what waited goes on by
itself. The Pendant screen shows a card while one is off, and no screen offers a summary while AI is.

The same row holds `openAppAfterMinutes`, the delay of the "Open lifelog" alert (Settings, Alerts; 0 is off). It is not
a switch, but it is set the same way.

### Who transcribes

The same row holds `transcriber`, who transcribes the next blocks (`PUT /switches {"transcriber": …}`; the status
and the feed show it with the switches):

- `scribe` (the default): each block goes to ElevenLabs Scribe whole, as above.
- `speech`: each block goes to the speech service (`apps/identity`, `POST /transcribe`), which answers Nemotron 3's
  speaker turns, VoxLingua107's language per turn and Parakeet Ultra's words (`route-turns.ts`). A turn of a second
  or more goes to Scribe when its language is neither English nor French, or the service wrote nothing in it; a
  block 70% foreign goes to Scribe whole, as a `scribe` job. The routed turns are cut from the block's own Ogg Opus (packets moved, a
  quarter second around each) and sent to Scribe once, without a webhook; their words come back into the turns'
  seconds with the service's speakers. The transcript has Scribe's shape, so turns, conversations, speakers, the
  feed and Life read it the same. Why these rules: `docs/research/transcription-bench.md`.

A job keeps the transcriber it was sent with (`transcription_jobs.transcriber`). The service busy, the block is
queued again (not an attempt); down, failing or past its 120 s wait (504), it is an attempt, and the third goes to Scribe whole, so nothing
loops. One cut off by a restart goes again after 10 minutes, unless its routed turns had left for Scribe: those may
be billed, so it fails. Its `billableSeconds` are Scribe's price of the seconds it heard. Without `IDENTITY_URL` set,
`speech` still sends to Scribe, and so does Host with "Recognize speakers by their voice" off: that toggle runs
the whole speech service, transcription included. ElevenLabs credits used up, Scribe's jobs wait queued, but the speech service
still hears every block: one with only English and French completes; one that needs Scribe waits for the credits,
queued and never due, until a read of them finds them back, and is then heard again (on the Mac, free) before its
other-language turns go. The waiting reason `creditsOut` follows: every busy conversation while Scribe transcribes; with the speech
service, a conversation with a block waiting for credits (`waitsForCredits`). The status counts them
(`waiting.forCredits`) and Host's menu shows them. Dictation never reaches either: the worker's gate runs first.

### No limits

Nothing holds or caps transcription: every admitted job goes. Spending counts every job and the
presses of the Pendant's button transcribed at once (`quick_transcriptions`, `docs/pendant.md`).

### Speakers

When a block's job completes, the server cuts its clean turns itself (`excerpts.ts`). A clean turn has a
speaker, at least 1.5 s, no overlap with another speaker and no word stretched over 3 s (the provider sometimes
stretches a word over speech it didn't transcribe): `uncleanTurn` in `people.ts` is the one rule. Clean turns are cut
from the job's own Ogg Opus, longest first up to 200 per job, each to its first 30 s. The audio and the turns' ranges
go to `apps/identity` once (`POST /embed-ranges`), which returns one embedding per range; they are stored as voice
samples of source `server`, and the server recognizes. Identity gets the whole Ogg, so a block whose map touches a
quiet range (dictation, playback) is never cut, nor is an old job's audio the phone sent again (`PUT /jobs/{id}/audio`):
it may hold dictation from before the Mac kept quiet ranges. A turn the phone sampled before the rebuild keeps that
sample. A job whose cut failed (identity away, transcription switched off) is tried again by the 5-minute tick, within
30 days. The phone sends no voice samples.
Recognition never sends audio for transcription.

Who spoke each turn (`speakers.ts`, measured against the owner's answers; `eval:voices` replays `match` alone on
them):

- A speaker's clean turns together are the person their voice matches: cosine at least 0.6 to the profile and 0.1
  ahead of the next person, with at least 8 s of clean speech.
- A turn whose own voice is nearest the owner's, at 0.5 or more, is his, whoever the speaker is: the provider often
  puts him and someone else under one speaker. A turn under 6 s needs only 0.4 if it is also 0.1 ahead of the next
  person (short clips score lower, and his short requests said alone stayed unnamed). His own correction of a
  turn wins, and recognition never replaces it.
- An answer (the phone's, "Who's this?", or a reader's correction) writes the owner's row and moves its
  evidence, nothing more; a minute later the sweep matches every transcript again, that one included.
- Who a turn is: its own row (the owner's correction of it, or a turn moved to him), else its speaker's. One rule
  (`people.ts` `speakerOf`) for the feed, summaries, readers and new evidence, and a turn named on its own is never a
  sample of its speaker's voice (`ofItsSpeaker`).
- A voice that matches no profile can take the name of a voice in another recording within 45 minutes that sounds 0.70
  alike and leads the next person by 0.1. Only voices the owner named or that matched a profile at 0.65 count as
  references; a voice named this way never names another.
- A provider speaker can hold several people. Only the owner says so ("Several people" in "Who's this?"): he names
  each clip in place, its turn alone (one of his people, someone new, or "don't know"), then Done says who: those he
  named, himself, and "unknown too" if a clip was "don't know". His row on the voice holds them (`candidates`) and
  names nobody, unless one person besides him is picked without "unknown too": the turns no voice decides fall back on
  them. Recognition then decides each sampled turn among the candidates only: nearest, 0.1 ahead of the next, and at
  0.4 when the set is closed (no "unknown too", and each candidate has a profile), else the usual 0.5 for him and 0.6
  for others, at once on the answer. A turn's row, once written, is kept. The voice is nobody's evidence and never a
  nearby reference; the clips he named are his rows, and so evidence. The phone then asks Generate for its
  conversations; nothing else re-runs.
- Before the multi-select, "several people" named nobody and marked the speaker `mixed`. Those voices come
  back in "Who's this?", each on its own card (kind `several`, past the stranger and media checks) that opens with
  each clip to name; recognition leaves them as they are until then, and the column goes once none is left.
- A person can have other names (Mamie for a grandmother, Jojo for Marie-Jo). Summaries, the assistant's `person` and
  `assign_speaker` tools and "Who's this?" find people by them, so a nickname never creates a duplicate. They are set
  on the person's page, and learned when the owner answers a voice the summaries heard as "Jojo" with Marie-Jo. A
  merged person's name becomes an alias.
- Unnamed voices are grouped across conversations by how alike they sound (0.6, average linkage), each night and a
  minute after the owner's answers (`regroup`, with the sweep); a new voice is its own card until then. The queue asks
  about each group once. A queue card's clips come from the voice's samples, best first, else from its turns with the
  most words. A clip is its turn's words begun in the first 20 s, from the first to the end of the last; a clip of a job with stored audio
  names the job and the turn's start and end in that file (`GET /transcripts/{jobId}/audio`, Ogg Opus, `Range`
  honored), so every card has clips. A job from before the audio store has none, and the phone plays its own recording;
  cards with a clip to play come first. A card's id is its unnamed group, or its one voice's `jobId/speaker_0`, the
  id `fetch` and `assign_speaker` use too.
  Voice data that is nobody's evidence is deleted after 30 days.

### Summaries

Summaries run only on the Mac, on the selected ChatGPT or Claude subscription; nothing sends them to a paid API. A
call is waiting, not failed, when the Mac is away. Owner titles are never sent, so they are never replaced.

**One rule, one kind of run** (`rolling.ts`, `intelligence.ts`). Every summary is a roll. A live conversation grouped on
the server, of talk, is **due** when its words differ from what its last finished roll read (`conversations.turns_fp`:
its turn keys, and whether it was open), or when its latest run waits. However late its words came (held audio,
credits out, the phone offline), it is summarized once they are there, and it shows `macAway` while the Mac is gone.
Due conversations roll after each grouping, when the Mac wakes, and every 5 minutes while it is there, three at a
time, newest first. A drain looks only at the conversations the change log touched since the last one and those left
due, never at the whole archive. At most one roll per conversation runs; a request during a roll makes one more after
it.

- A roll reads the tail: the turns after the chapters the latest valid run closed, at most about 24k characters (some
  20 minutes), and only words before a block still being transcribed. A conversation longer than that rolls window
  after window until its words are covered; then its fingerprint is kept.
- One chapters call over the tail; it is told the conversation goes on when it is open or the window ends before its
  end. A chapter closes when another follows it, before a confident new conversation, when the conversation is closed
  and the window reaches its end, or when one topic fills the window. Each closed chapter is summarized at once, four
  at a time (the Mac's slots), then the title and TLDR are written again from every chapter; that call never reads
  the transcript. Chapters already closed cost no call. A roll that closes nothing keeps nothing.
- Chapters of the previous run are carried only while their turns are the same, from the first turn: a split keeps
  the chapters before it, and the piece after it rolls from its own first turn. A piece cut exactly at a chapter keeps
  its chapters and buys only its title.
- Each roll is a run (`coverage.mode` `rolling`), so every reader shows the latest valid one. A roll the Mac dropped
  waits and resumes in place, asking only for what it has no usable answer to (`intelligence_calls`, keyed by run,
  stage and the call's hash, even one the Mac sent after the call timed out). A restart puts running runs back to
  waiting at boot. A run still running is never started twice. A failed roll is taken again 5 minutes later, then 10,
  20, 40, then once an hour.
- Chapters a turn off are clamped, not refused. An unusable answer (not JSON, cut off, uncited, or a provider error)
  is asked again twice, 5 and 15 seconds later, for that call alone. A chapter still without a summary keeps its
  error; the run is invalid only when the title is. Each call keeps its tokens and the turns it read.
- Each chapter is a `chapters` row, logged for the feed, with an id from its conversation and start, so a chapter
  summarized again keeps it. It ends where the next starts. `summarizedAt` is its first summary.
- A confident new conversation (high confidence) is an AI split at its first turn (`owner_edits`, source `ai`, its id
  from its instant, once). Grouping applies it at once and the new piece rolls on its own; the owner's merge undoes
  it, and the phone shows "Split by AI · Undo". A medium one stays a suggestion in the feed (`splitSuggestions`):
  "Split here?" posts a `split` edit, dismissing a `dismissSplit`. Low ones are dropped. The chapters call is told what
  the phone measured (silences of two minutes or more, where the owner travelled). The same people going on, short
  asides, dictating, overheard talk and media are never a new conversation. A silence must show five minutes in the
  turn times.
- **Generate** (`POST /conversations/{id}/intelligence` with `after`, the run the owner saw): when a run newer than it
  is valid, running or waiting, nothing happens. Otherwise it rolls again from its first turn, every chapter closing;
  the summary shown stays until a newer run is valid, and stays for good if the new one ends invalid. With the Mac away
  a run waits for it, and starts from the first turn too.

**What every summary shares.**

- Each turn's speaker goes to the model as a token (S1, S2…) with a legend: the owner, the owner's people by name,
  voices not identified yet. Chapter summaries and the TLDR write speakers as `{S2}`, in the past tense; titles name
  the topic, never a speaker. The run keeps which voices each token stands for (chapter rows keep the tokens too),
  and the server renders the text when it is read with the one name every reader gives a speaker
  (`transcript.ts` `speakerNames`): a person's name, the owner's too, else "Speaker N", the conversation's voices
  without a person numbered in order of first appearance, exactly as the transcript and the feed's
  `speaker.displayName` call them (`speaker-tokens.ts`). Naming a voice later fixes every summary with no new call;
  the feed sends the conversations that voice speaks in again, with their chapters and turns.
- The conversation page heads the transcript with each chapter's title where its first turn starts, once there are
  two or more; tapping a title plays from there.
- Renaming a person, correcting a speaker or answering "Who's this?" goes through the phone's outbox; the feed brings
  the result back, with changes made elsewhere (the owner's assistant).

### Silent push

When ElevenLabs' webhook completes a job, a summary run ends, transcription is switched back on, or the phone holds
audio it could send while the Pendant records (see Latency), the server sends the app a silent push
(`content-available`, priority 5, `"lifelog": "processing"`) to its alert push token. The app runs the driver at once,
in the foreground or woken in the background. iOS may hold or drop such pushes, and never delivers them after a
force-quit, so the next Bluetooth sync or launch catches up. Each push is an `apns.sent` event. The same token gets two
alert pushes: once a morning, the number of voices waiting to be named, and "Open lifelog" when the Pendant's audio has
waited on the phone past the owner's delay (see Latency).

### Location

The phone records one fix every five minutes while the app runs and the Pendant isn't known to be paused, with its
own time and accuracy. Bluetooth keeps the app running in the background, so with Always access the fixes cover the
day. iOS visits come too: arrival and departure at places the owner stays, reported even while the app isn't running
(it relaunches the app). Every fix and visit goes to the server's location history once, at the end of each run; a
visit is sent again when its departure comes. A fix carries Apple's name for where it was taken (`placeName`), when the
phone has one. The server names a conversation's place from its most accurate named fix (`places.ts`); grouping reads the fixes for
travel; the history answers a reader's `GET /where` and `GET /visits`.

## Phones send pages, the server decides

A thin phone (first the Android app, draining an Omi) labels nothing and renders nothing. It sends its raw pages, byte
for byte, as soon as they are durable (`raw_pages`, `pages.ts`; the contract is in `docs/sync.md`), and the server
does what the iPhone does on the phone (the rules ported in `page-rules.ts`), after every stored batch, every word from
the Mac and on the 5-minute tick, one bounded pass per source (`page-processing.ts`):

1. **Label** (`page-labels.ts`). The next 3000 pages in index order (about 5 minutes of Omi audio) are placed in time
   as the iPhone places Omi records (frames 20 ms apart from a run's first whole-second stamp, again where a stamp
   jumps), cut into pieces of whole pages of one span, 10 minutes at most, decoded and labeled by Silero, each second
   speech with 8 frames at 0.3. Decoding and Silero run in a Bun Worker (`vad-worker.ts`), one piece at a time, off
   the server's thread. A piece still growing when a batch ends stays open in the worker, its decoder and Silero's
   state kept, and goes on with the next batch, so labels never restart at a batch's edge (a restart labels it again
   from its first page). A piece is a `page_pieces` row: its pages, where it plays, its speech; its pages are then
   `labeled`. A missing page is waited for 2 minutes, then labeling goes on past it as a break; a page that comes after
   that (a late page) is labeled on its own, from its own stamps, leaving a piece still open as it is, and the cut
   goes back to it (`pages.late`). A worker that ends (a crash, an exit) settles every call waiting on it; a piece it
   held open is labeled again from its first page, whose pages were never marked labeled. Apple's
   sound classifier has no portable equivalent: speech is Silero's alone, and what is audible the energy
   detector's (each second's level). Limitless pages wait for their decoder.
2. **The server's VAD never hears dictation.** Only audio before the Mac's watermark (`vouchedThrough`, the one the
   cutter uses) is labeled, so every dictation in it is already a quiet range, and no packet a quiet range touches is
   decoded or given to Silero: it is silence there, never read. A range the Mac reports later, over audio already
   labeled, withdraws the fragment as for the iPhone, and its audio is never decoded again: the cut reads the stored
   labels.
3. **Cut.** From the source's cursor (`sources.pages_cut_from`), the iPhone's uploader exactly: kept speech (1 s
   padding, gaps under 3 s kept, quiet ranges out) of pages no job or fragment holds, an hour of capture read at a
   time, ends where `SpeechFragment.next` ends it, at most 20 fragments a pass. Each goes in through `storeFragment`, as
   an upload would, so the cutter, the quiet ranges, `claim` and paid-once are the same. Its audio is the original
   Opus packets in Ogg, each stretch narrowed to whole packets, 0.4 s of silence between stretches. The cursor moves by
   compare-and-set: a fragment the cutter withdraws, or a late page, moves it back meanwhile, and those pages are cut
   again (without the range).
4. **Progress.** Heard-through is the labeled audio less 3 s (the record being written when the phone drained), or
   all of it once every page is labeled and nothing came for 10 minutes; sent-through is where the first kept second
   not cut starts. The cutter closes blocks on them as on the iPhone's. `GET /sources/{id}/ingest` says where the labels
   reach (`labeledUntil`).

5. **Timeline.** Each labeled batch writes the source's timeline spans as the iPhone's `FactsBuilder` would
   (`docs/timeline.md`, "Timeline facts"), and each pass regroups the source, so its speech becomes conversations
   and its transcripts land in them.

The parity case is `fixtures/pages` (made-up speech): Kit's `PageProcessingParityTests` writes what its own code makes
of it (labels, kept audio, fragments, timeline spans), and the server's tests match it.

**The iPhone's switch to pages** passes when, over one day of the owner's real capture sent both ways (the iPhone's
fragments as today, and the same pages sent raw to a second source), the server's fragments keep within 5% of the
iPhone's total kept seconds, and their transcripts within 5% of its words; and the iPhone sending pages costs no more
battery per hour (Settings' battery log) and no more than twice the bytes per hour uploaded. Then the iPhone stops
labeling and rendering, and Kit loses `Upload/SpeechFragment.swift`, the fragment half of `Upload/Uploader.swift`,
`AudioPipeline/SileroDetector.swift` and its model, `AudioPipeline/ActivityAnalysis.swift`,
`AudioPipeline/PreparedAudio.swift`, `SpeechPolicy` in `Timeline/Activity.swift` and the heard-through half of
`Upload/FactsBuilder.swift`; the server loses `PUT /sources/{id}/speech`. Playback files stay on the phone.

## Uploads and pairing

Uploads use an ordinary session, not a background one. A fragment is at most 90 s of speech (a few hundred KB), and
a lost upload is simply sent again with the same pages. The phone is paired with its server by a link,
`lifelog://pair?url=…&token=…`, that the Camera opens in the app from a QR code (or pasted in Settings, under Server); the
app asks before it pairs, naming the server, and warns when it would replace another. The token lives in the Keychain (this device only), the server's URL in the app's defaults;
both are read on every request. There is no built-in server: a phone without a pairing is not paired. In debug
builds, launch with `LIFELOG_DEVICE_TOKEN` and `LIFELOG_SERVER_URL` in the environment to pair with that server.
The links an app must accept or refuse are `fixtures/wire/pairing-links.json`, which Kit's `PairingTests` read; the
Android app tests the same file.
