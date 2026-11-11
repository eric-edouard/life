# Timeline

`apps/ios/Kit/Sources/Timeline` places stored Pendant pages in capture time and decides which audio to upload. The
phone sends the server its timeline facts and blocks of kept audio; the server groups them into conversations. This
page covers the clock, the speech rules, blocks and facts on the phone, then the grouping rules on the server. It only
plans; it never deletes.

## Three timelines

- **Capture time** is the canonical one: Unix-epoch milliseconds from the Pendant clock, corrected for drift.
  Words, boundaries and places are stored in it.
- **Device time** is the raw clock value on each page. Each time sync resets the clock, and at the next sync we
  read how far it had drifted. We assume the drift grew evenly in between and correct each page by its share.
  A page drained days late lands where it was recorded: arrival time is never used.
  Each sync is stored with the first page it governs: the page after the newest one the Pendant reports just after
  the set. The newest page is the one being written, and a page is stamped when it opens, so that next page is the
  first one the set stamped (verified). That page is the sync's **anchor**.
  **Boots.** Within one boot the RTC is the uptime plus an offset that only a set changes (verified). So every page
  of a boot with an anchor is timed by its uptime from that anchor: the latest one at or before it, else the
  earliest after it. That fixes the clock a reboot restores wrong (32 s behind on the owner's unit) and pages
  stamped before the RTC was set at all. A page with neither a trustworthy RTC nor an anchor stays untimed: kept in
  the source store, left out of the timeline.
  **Drift is mostly unmeasured.** Status replies carry no clock. The only reading is a live short press: it carries
  the Pendant's time of the press, and the phone receives it a moment later. It counts only when the press counter
  rose during this connection (a status replayed at connect may carry an old press) and the gap is between 1 s and
  7 days; under a second it is latency, not drift. Such a reading closes the epoch at the next set. Drift that grows
  while the Pendant is disconnected is never measured, because every connection sets the clock first; those epochs
  stay uncorrected (`docs/pendant.md`, "Hardware tests still owed").
- **Prepared time** is a block's audio: kept stretches back to back (see Blocks). A time map converts each way
  exactly.

Each Opus packet plays at its page's capture time plus its chunk offset (`time_offset_ms`). Packets within 60 ms of
where the previous audio ended continue it back to back, absorbing the Pendant's write jitter (±4 ms, no drift).
Pages become spans of continuous audio. Inside a span, a stretch of up to 1 s without packets is silence, so Opus DTX
(a packet at least every 400 ms) never breaks one. A new span starts after a longer stretch without packets (nothing
was recorded), at missing page numbers, or after a page without a usable time. Storage sessions don't matter: the
Pendant starts a new one every time it starts or stops recording.

**Overlaps.** Page indices only grow, so audio is never placed before audio of a lower index. If a page's clock
says otherwise (a clock stepped back with no anchor to fix it), its audio starts right where the earlier audio ends,
in a new span marked `overlap`. Every packet plays exactly once and none is dropped; only the time between the two
is uncertain.

## Speech and kept audio

We upload only speech. A second is speech when Silero or Apple's sound classifier says so, at any confidence. The
energy detector and `uncertain` labels never make speech where Silero ran: on a train they turned four hours of
rumble into one conversation. Files analyzed before Silero keep the old rule (any analyzer's speech). Audio nobody has
analyzed yet counts as speech, except pieces under a second: those are seams where a playback file's labels end a
few milliseconds before its span, and counted as speech they held every noisy pause together (a 2.5 h working
morning with 11 min of speech stayed one conversation).

**Kept audio** (`SpeechPolicy.keptAudio`) is what goes up. Each stretch of speech keeps 1 s on each side, and only
gaps of at least 3 s are cut, so pauses inside a conversation stay. Quiet ranges (the owner dictating to the Mac, or
the app playing a recording out loud) are left out whatever the analyzers heard. Silence and non-speech sound (music,
traffic, a TV with nobody talking) are not uploaded. There is no loudness test (see `docs/decisions.md`).

## Fragments and blocks

A **fragment** is the kept audio of a run of whole Pendant pages, rendered as Ogg Opus 16 kHz (`SpeechFragment`,
`PreparedAudio`). It is identified by its source and its pages, and no page goes into two. The server joins a
source's fragments into **blocks** of up to 2 minutes and makes each one job (`cutter.ts`).

- A fragment ends at a page's end, within 90 s of speech: at the last pause (outside kept audio, with speech after it
  or `heardThrough` past it, so speech still going on never ends one); with no pause and a minute waiting, inside the
  latest second the analyzers call non-speech; with neither, at 90 s. So seams fall in silence. Kept stretches under
  half a second are left out: they hold no word, and the provider refuses a near-empty file as corrupt.
- It doesn't wait for the Mac: the server joins no fragment before the Mac vouches for its block's end
  (`docs/processing.md`).
- It holds only pages the server doesn't hold yet, across the whole archive: a page in a job or a fragment (an old
  part included) is taken out with its audio, so a fragment never mixes held and unheld pages. The phone reads an hour
  of capture at a time from its cursor.
- **Prepared time** is the uploaded audio: kept stretches back to back, with 0.4 s of silence between them so words
  from different stretches never run together. The **map** (its kept capture intervals in order, and the separator)
  converts each way exactly, on the phone (`TimeMap`) and on the server (`transcript.ts` `captureMillis`, with the
  joined job's `starts`). Provider times are rounded inward: a word that crosses a separator snaps into the stretch
  holding most of it, never into the silence that was cut out; a turn's start inside a separator moves forward to
  the next stretch and its end back to the previous one.
- A fragment's map isn't moved after it went up: one is sent seconds after its speech, and none of 121 jobs
  measured moved. The server logs `job.span_moved` if a span it holds comes back moved.
- Identical input gives identical bytes, so a fragment's hash is stable.

## Timeline facts

`PUT /sources/{sourceId}/timeline` (`FactsBuilder`) tells the server what the phone knows about time, per **span**
(one continuous stretch of capture, keyed by its first page; a span replaces the stored one with the same first page):

- its start and end;
- `speech`: the speech rule above, with `uncertain` labels counting too in files analyzed before Silero
  (`speech(orUncertain: true)`);
- `audible`: audio some analyzer other than Silero heard something in, which tells noise from true quiet;
  `unanalyzed`: audio no analyzer has reached;
- `breaks`: why the span doesn't continue the one before: `timeGap`, `overlap`, `missingPages`, `recordedGap`,
  `untimedPage`;
- `pauses`: confirmed recording pauses inside it.

**Recorded** is what the spans say of a stretch of time: a Pendant recorded in it when one of its spans overlaps it
(`recorded`, `GET /recorded`). Speech or silence makes no difference; an old-app recording is no Pendant's. Before the
first span held (`since`), the absence of a span says nothing.

And `heardThrough`: the capture time of the durable, analyzed, contiguous page prefix. It only moves forward, and
grouping closes a conversation once it is 5 minutes past its end. A late page, a new gap or a clock change sends the
spans from where they changed again, at most 200 per request.

A thin phone sends none: the server writes a raw-page source's spans itself from its labeled pieces
(`page-labels.ts` `spansOf`, through the same `saveSpans` as the route), each time a batch is labeled, in the same
shape. Each piece records its span when it is made (`span_first`, the span's first page): the span of the piece it
goes on from, else its own first page. A span's pieces start where the one before ended, so a short silence between
batches is inside the span, not a seam. `speech` is Silero's, `audible` the energy detector's (a second at -50 dB or
more; Apple's sound classifier has no portable equivalent, so noise it alone heard counts as quiet there),
`unanalyzed` what no piece covers for a second or more, `breaks` the first piece's, and no pauses (an Omi confirms
none). A late batch (pages stored after labeling passed them) is a span of its own, placed by its own stamps, beside
the spans around it; the span after its hole keeps the breaks it had. The server writes its heard-through too, and
regroups the source after each pass, as after the iPhone's timeline (`regroupAfterCommit`). `fixtures/pages` holds
Kit's `FactsBuilder.spans` of the same pages, which the server matches.

## Grouping (server)

`apps/server/src/grouping.ts`, per source under a lock, from the facts, the transcribed words, Mac dictation, location
fixes and owner and AI edits. Its cases are in `apps/server/fixtures/segmentation/`. The constants are `POLICY`, in one
place, and a deploy applies a change forward.

**What counts as speech.** Possible speech is the facts' speech plus the words, less Mac dictation (dictation is not
conversation), plus unanalyzed audio, plus the time before a span that starts after `missingPages` or `untimedPage`
(unknown audio). Pages the Pendant reported unreadable (`recordedGap`) are a known loss instead, like time it didn't
record. A boundary can only fall between possible speech, so it never cuts a sentence or a word. A pause becomes a
boundary when it has:

- 45 s of unbroken quiet or no recording. A short reply after a shorter pause stays in its conversation. Quiet means
  no analyzer but Silero heard anything: Silero labels noise and quiet alike as silence.
- a confirmed recording pause (Pendant telemetry, including the firmware long-press). A pause the app asked for but
  nothing confirmed never splits. A resume never splits: it is confirmed a second or two after recording started. A
  new device session never splits on its own.
- 5 minutes without speech, even with sound such as TV, traffic or a room's chatter. It was 15 while noise could pass
  for speech, then 10; a working morning (11 min of speech in 2.5 h, 3–10 min between remarks) stayed one
  conversation at 10, and 5 gave eight that matched it.
- 2 minutes without speech, when the owner also moved at least 500 m.

**Location** only supports a split, because a venue change doesn't end a conversation that keeps going. It matters for
travel: walking or driving is noisy, so the trip is rarely silent, yet it usually separates two conversations. It
never applies to a pause under 2 minutes, so dialogue in a car or on foot stays together. GPS drift can't trigger it:
both fixes must be accurate to 100 m, and their distance minus both error radii must exceed 500 m.

**The cap.** A conversation over 60 minutes with no boundary is cut at its longest pause, so a summary never waits for
hours. The cut is kept as an AI split (its id from its instant, as every AI split's): the next run
makes the same one, and the owner's merge undoes it for good.

**Edits** (`POST /edits`: split, merge, undo, dismissed suggestion; kept by the phone's uuid). AI splits (from any valid
summary run) are applied first, like the automatic boundaries, so the owner's merge undoes one for good. The owner's
follow in edit order and win. An undone edit is skipped, and a dismissed suggestion groups nothing. An edit regroups
every Pendant source (one today).

**History.** The cutover to server-side grouping wrote each handed-over Pendant conversation once as data: a timeline span of audio the phone
never analyzed over its range (under a negative first page, so no phone span replaces it) and an AI split at its start
(an owner's merge removes it). Facts the phone sends later sit beside it. So history regroups to itself, and the
owner's edits apply to it. Imported recordings stay as handed over: the phone
plays each from its own file, by its id, so the server refuses a split or merge inside one and the app does not offer
it.

**Forward-only.** A change (spans, a block's words, a moved map, an edit, an AI split) marks its capture range dirty on
the source (`sources.dirty_from`, `dirty_to`) in the writer's own transaction. A run takes the source's lock and
regroups the dirty range: from just before the last conversation starting at or before it (or from its end when the
change is 5 minutes past it), up to the first closed conversation that starts after it, which stays as it was grouped,
and everything after it too. A conversation whose end is 5 minutes behind heard-through is closed: only an edit or late
audio that touches it changes it again. The run clears the range it covered; a run that failed leaves it, and the
5-minute tick regroups it (`regroupDirty`). A run with nothing dirty only closes what heard-through passed.

**Every writer logs last.** Grouping, titles and waiting reasons write their rows first and log them for
the feed at the end of their transaction (`change-log.ts`), so no two wait on each other. A regroup logs every
conversation it changed, and only the turns whose conversation changed: the feed's `conversationId` on each is
the server's placement, the one rule the phone reads. While a conversation's start stays, those are the turns between
its old and new end, so the open conversation growing sends its new turns, not all of them. A moved start renumbers
its voices, so it sends every turn of the old and new range.

**Ids** are the instant a conversation first started (its anchor), written into a UUID (`docs/formats.md`). A later
run keeps an id while its conversation still covers that instant, or starts at most 2 s after it, so titles and edits
stay attached. A split keeps the id on the part that holds the anchor; a merge keeps the earliest anchor it covers. A
conversation no group claims any more (a merge, an undo, a clock change) is retired to the one covering its anchor,
or else its range, and a later split brings it back at its id. The feed names the live edits that made each
conversation's edges (`startEdit`, `endEdit`: the split each edge comes from, else the merge that joined it), so Undo
undoes exactly that edit. Transcripts are found by time, so merged words show in
the merged conversation and split words in each part; nothing already bought is stranded.

**Kind.** `silent` once every job over it is transcribed and it has no words; `dictation` when it lies inside one Mac
dictation range; else `conversation`, whatever its origin. `imported` came from the cutover
(old-app recordings, never regrouped; a split or merge inside one is refused with a 400). **Waiting** says what blocks
it (`docs/processing.md`).

## Derived audio

`apps/ios/Kit/Sources/AudioPipeline` turns stored pages into audio. It runs from the derived job queue, after pages
are durable, and a failure there only retries the job with backoff: it never touches ACK or capture. It rests while
the phone is hot or in Low Power Mode.

- **Decoding.** Each Pendant packet becomes exactly 20 ms at the time the timeline gives it; moments between packets are
  silence, and decoding restarts after them. Tiny silence packets go through the decoder. A packet the decoder rejects
  becomes 20 ms of silence and a recorded decode gap; a page that can't be read at all is recorded too and left out, so
  the timeline sees missing pages there.
- **Playback.** Each continuous span is written as AAC files (16 kHz mono, 24 kbps, about 11 MB an hour) of at most
  10 minutes, so playback streams and seeks without loading a recording whole. A JSON sidecar per file maps file
  offsets to capture time in whole milliseconds. AAC was chosen on evidence: exact length and sample-exact seeking
  in AVFoundation. Opus in CAF was larger and seeked poorly; Opus in MP4 failed to seek or write.
- **Upload.** A block is rendered as Ogg Opus (24 kbps, about 18 kbps on speech) from the source pages, with 0.4 s of
  silence between kept stretches. Identical input gives identical bytes, so the hash is stable. AAC files carry their
  write time, so they are never identical; FLAC is about ten times larger.
- **Storage.** Everything lives in Application Support/lifelog/derived, excluded from backup, while the index of its
  sidecars (`timeline.sqlite`) is not. A sidecar the index names but the directory lacks is unanalyzed audio; from
  the uploader's cursor (or the facts owed) on, it is rebuilt from the source packs and analysis stops at the first
  rebuild still queued (`TimelineScanner.scan`). Older lost ones are not rebuilt. A file's sidecar is written last; a retried job skips files
  that have one, and hands their sidecars to the timeline's index again. Times are fixed when a file is written, so the files must be rebuilt after the clock model changes.

### Activity analyzers

Three independent analyzers label each second. Silero and the sound classifier decide what is speech; the energy
labels only tell noise from quiet.

- **silero-vad 6**: Silero VAD v6 on the phone (Core ML), a speech probability every 32 ms. A second is speech when
  at least 256 ms of it are above 0.3. Files analyzed before it existed are rebuilt once, in the background.
- **energy-vad 2**: loudness, zero crossings and how much the level jumps between 20 ms frames. Only very quiet
  audio (below -60 dBFS) counts as confident silence. Weaknesses: the thresholds were never tuned on Pendant audio;
  a quiet whisper reads as silence; music and steady rhythm can read as speech.
- **sound-classifier 2**: Apple's built-in classifier (303 labels). Voice labels (speech, whispering, laughter and
  similar) count as speech; a room's chatter, babble or crowd does not; any other confident label is sound. It never
  reports its own "silence" label, even on digital zero, so "nothing recognized" counts as silence at low confidence.
  Weaknesses: it hears the AAC file, not the source; it labels only whole seconds, so a file's last partial second is
  unlabeled (and so kept).

Untimed audio (a page with no trustworthy clock) has no place on the timeline, so it gets no playback file yet.

## Still provisional

- The 60 ms continuity tolerance and the 1 s silence fill. Whether a packet's offset marks its start or its end
  (20 ms either way; we say start). Uptime is trusted across a whole boot; its crystal drift over a long boot is not
  corrected.
- Playback files are written per derived job with the anchors known then. A later anchor in the same boot moves
  those pages; the files must be rebuilt (as after any clock model change).
- Every threshold: 45 s, 5 min, 2 min, 500 m, 60 min, 1 s of speech padding, 3 s gaps. Tune them on real days.
- Whether sound-only stretches should form conversations (today they don't).
