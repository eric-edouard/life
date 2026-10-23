# Export format: lifelog-export v1

One format for sharing, backup and import. The code is `apps/ios/Kit/Sources/Export`; the goldens in
`apps/ios/Kit/Tests/ExportTests/Golden` show every text file byte for byte.

## Layout

```
manifest.json
2026-10-07 09.12.03 Lunch with Mai/      one folder per conversation (local start time + title)
  audio.m4a        AAC, portable        (optional)
  audio.wav        PCM                  (optional)
  transcript.txt
  transcript.md
  captions.srt
  captions.vtt
  conversation.json
```

Each item has only the files the owner chose: audio only, text only, or both. When the whole export is a single
file, that file is shared alone, named after its item; anything more, and every backup, is zipped. The ZIP comes
from the system: a coordinated read of the folder with `NSFileCoordinator` `.forUploading` returns a ZIP of it, on
iOS and macOS, so there is no ZIP code or dependency. The importer reads the unpacked folder; Files unzips on tap.
Sharing goes through the native share sheet; nothing is sent until the owner picks a destination.

PDF is not in v1. The export sheet says so rather than offering it.

## Times

- **Capture time** is Unix milliseconds of original capture (Pendant clock, drift-corrected). Never the time
  audio arrived on the phone.
- An item covers exactly its requested range: a whole conversation or part of one. Words, edits and
  location fixes are included when they start inside it; anything crossing an edge is cut at the edge.
- **Audio time** is milliseconds into the item's audio. Both audio files start at the range start and run
  linearly to its end. Stretches the Pendant did not record are silence and listed under `unrecorded`. So
  `audioMs = captureMs - start.captureMs`, always. Silence skipped for transcription is never cut from exports.
- "Did not record" means no playback file covers the stretch. Audio not yet derived counts too, so export once
  processing has caught up.
- SRT and VTT cues use audio time, so they play alongside the audio. The VTT note gives the UTC start.
- TXT and Markdown show local wall-clock times in the time zone named in the header.

## Conversation ids

A conversation's id is the capture instant it started at when it was first seen (its anchor, Unix milliseconds). A
later grouping run keeps the id while the conversation still covers that instant, or starts at most 2 s after it, so
titles and edits stay attached (`grouping.ts`). A split keeps the id on the part that holds the anchor; a merge keeps
the earliest anchor it covers.

The id is a UUID with the anchor's milliseconds in the last 48 bits of an otherwise zero UUID, with version and
variant 8: `00000000-0000-8000-8000-` followed by 12 hex digits of milliseconds (`anchorId` in `grouping.ts`). The
server reads the anchor back from it to keep ids stable. Conversations from before the rebuild keep the ids the
phone gave them in the same form (`ConversationID.serverID`).

## The time map

What is uploaded for transcription is not the raw recording. Each fragment keeps only the capture intervals worth
sending (speech, minus the quiet ranges), played back to back with a short silence between them, the separator: 400 ms
today (`TimeMap.swift`). A transcript's times are seconds into that prepared audio.

- Each speech fragment goes to the server with its time map: its kept intervals in order (`[start, end)` in Unix
  milliseconds) and `separatorMs` (`PUT /sources/{id}/speech/{firstPage}`); the server joins a block's fragments and
  their maps. A job from before the rebuild keeps the map copied from its part; one the phone uploaded whole, before
  the server cut blocks, has its own.
- Capture time of a prepared position: walk the intervals, each followed by one separator. A position inside an
  interval maps linearly into it.
- A turn's start inside a separator moves forward to the next interval; it ends with its last word, so a turn never
  starts or ends in cut-out silence. A turn may span several intervals.
- A word always lands inside one interval, the one it starts in, and its end is cut at that interval's end: the
  provider stretches a word over the separators and silence after it (a short word has lasted 94 s).
- Past the last interval there is no capture time.
- A fragment the server cut from a thin phone's pages (`page-audio.ts` `fragmentAudio`) is the Pendant's own Opus
  packets with no pre-skip, each interval narrowed to whole 20 ms packets and split where packets don't follow each
  other; its separator is 0.4 s of CELT silence frames.
- A job whose audio the server joined from speech fragments (`audio.ts` `joinOggOpus`, `cutter.ts`) has
  `starts` in its map: where each interval begins in the joined audio, in ms, from packet counts and pre-skips. Each
  fragment's encoder delay and padding put a seam a few tens of ms past the uniform rule. With `starts`, an
  interval begins there, not one separator after the one before; everything else above holds
  (`transcript.ts` `startsOf`). `fixtures/fragments` holds a joined file the phone's tests decode.

- The prepared audio is kept as the job's audio in the audio store (`GET /transcripts/{jobId}/audio`). Only inside one
  interval do its time and capture time run together, so a "Who's this?" clip cut from it stops at the end of the
  interval it starts in (`transcript.ts` `keptAt`). The phone opens that Ogg file with precise timing: without it
  AVFoundation guesses a position from the average bitrate, and a clip 15 minutes in played 30 s early.

The phone (`TimeMap`) and the server (`transcript.ts` `captureMillis`, `keptAt` the other way) both map this way.

## Audio

Both files are 16 kHz mono, exactly as long as the range: `audio.m4a` is AAC at 32 kbps, `audio.wav` is 16-bit
PCM. They are made in one streaming pass over the 10-minute playback files (`docs/voice/timeline.md`), holding 30 s at a
time: each stretch is decoded from its file at its offset, and silence is written between. The AAC is re-encoded,
not passed through: AVFoundation will not splice several AAC files without re-encoding, and a composition drops
trailing silence, which would make the file too short. 32 kbps, above playback's 24, keeps the loss small.

## manifest.json

| Field | Meaning |
| --- | --- |
| `format`, `version` | `"lifelog-export"`, `1`. |
| `kind` | `export` or `backup`. |
| `appVersion`, `createdAt` | Who wrote it and when (ISO 8601). |
| `items[]` | `id`, `folder`, `startCaptureMs`, `endCaptureMs`, and `files[]` with `path`, `bytes`, `sha256`. |
| `files[]` | Every file outside the item folders except the manifest (backup only), same shape. |
| `unsupported[]` | `item`, `what`, `reason`: anything requested but not included, such as a conversation no longer in the library. |

## conversation.json

Version 2: what the phone's cache holds of the conversation. Keys are sorted and output is stable.
Every moment is `{ "captureMs", "audioMs" }`.

- `version` (3; 2 had `bookmarks[]`, since removed), `id` (the server's conversation id), `start`, `end`, `startUTC`, `timeZone`, `kind`.
- `title`: `{ text, source }`, where `source` is `owner` or `generated`. The owner's title always wins.
- `tldr`, `place`, and `chapters[]` of `{ at, title, summary }`.
- `transcript[]`: one turn each, `{ speaker, name, personId, start, end, text, language }`, as the server sends it
  (dictation and media already left out). `speaker` is the provider's label within its job.
- `transcriptAbsent`: present exactly when there is no text, saying why. An export is never silently empty; the
  same sentence appears in TXT, Markdown and as the only caption.
- `locations[]` (fixes with latitude, longitude, accuracy), `unrecorded[]`.

Captions cut a long turn into pieces of up to 84 characters, timed by their share of the turn: the phone keeps no word
times.

## Full private backup

A separate feature (Settings, Backup & restore). It copies the app's stores as they are, so nothing is lost:

```
manifest.json                         kind: "backup", no items
sources.json                          device, page range and path of each raw pack
stores/                               the app's Application Support/lifelog folder
  source/source.sqlite                receipts, gaps, clock syncs, incidents
  source/packs/1.pack …               raw Pendant pages
  library/library.sqlite              the feed's cache, the outbox, location history; the old pipeline's tables
  timeline.sqlite                     the scanned timeline; the old pipeline's parts
  derived/<device>/*.json             playback sidecars: analyzer labels and decode gaps
```

Every file is in the manifest with its size and SHA-256. Databases are copied first as consistent snapshots
(`VACUUM INTO`) while capture keeps running; packs only grow, so every receipt points at bytes already copied.
Derived audio is left out: it is rebuilt from the packs. So is `upload/upload.sqlite`: its cursor starts over around
what `GET /sources/{id}/blocks` holds. Voice embeddings are never exported, in any kind: the
library does not hold them.

## Raw backup in the audio store

The server keeps the phone's raw data so the archive survives losing the phone. Everything is under `raw/`:

```
raw/<sourceId>/<packName>-<sha256>.pack            a sealed raw pack, as the phone holds it
raw/<sourceId>/source-db/<yyyy-mm-dd>-<sha256>.sqlite   a VACUUM INTO snapshot of source.sqlite
```

A pack is uploaded once with `PUT /backup/packs/{sourceId}/{packName}` (at most 64 MB, `X-Content-Sha256` set and
checked); `GET /backup/{sourceId}` lists what is held, so the phone sends only the rest. The snapshot holds the receipts
that say how to read the packs; the server keeps one per UTC date, the last 7. Packs hold everything the Pendant
heard, dictation to the Mac included: they are stored and never sent to ElevenLabs, `apps/speech` or a model, and
no server code but `backup.ts` knows these keys. Speech audio of transcribed jobs is separate: the prepared Ogg goes to
`jobs/<sha256>.ogg` through `PUT /jobs/{jobId}/audio`.

### The phone's side

`Uploader.backUp` (`Kit/Sources/Upload/Uploader+Backup.swift`) runs in a lane of its own beside the driver's runs,
one round at a time, only on Wi-Fi, a wire or while charging: an item can take minutes, and fragments never wait for it.
A round goes until nothing is owed, the server can't take more, or the connection drops; the next run starts the
next. In order:

1. **Today's snapshot**, once per UTC date: `VACUUM INTO` from a connection of its own, as the full private backup does.
2. **Imported old-app jobs**, then 3. **sealed packs**, then 4. **old Pendant jobs**, each oldest first.

A pack is sealed once the store has rolled to a newer one (any but the highest-numbered `source/packs/<n>.pack`); the
open one waits. Its name is `<n>`. A pack is read memory-mapped, hashed and sent; it goes again only if its size
changed (the store trims a dead tail on reopen).

An old job's audio is rendered again exactly as the old pipeline rendered it: `PreparedAudio` (fixed Ogg serial, 0.4 s
separators, 24 kbps) over the part's time map, from the imported file or from the packs through the current timeline.
Only completed parts with a job and a hash count, one per job. If the render does not hash to the part's `sha256` (the
clock model moved, a file is gone), it is skipped and logged (`backup.skipped`), never tried again.

Progress is the `backup` table of `upload.sqlite`: one row per pack, snapshot date or job, with its outcome (`sent`,
`held` when `GET /backup/{sourceId}` already had it, or `skipped: <why>` after a 4xx or a mismatch). A 5xx or 429 stops
the round and the item goes next run; no connection stops the driver's run. The status sheet shows what is left.
The backup reads the store's files only: nothing it does writes `source.sqlite` or a pack, or reaches
`PageSink.ackableIndex`.

Once every old job is sent, the old pipeline's `parts` (in `timeline.sqlite`) are read by nothing and can go. The
library's old tables went after the cutover.

## Import

Only a backup is read back (Restore, below). The checker only reads its input. It fails closed on a manifest it does
not understand (wrong `format`, or any `version` but 1), on a missing file, on a size or SHA-256 mismatch, and on a
path that leaves the folder. Files not in the manifest are reported and ignored.

## Restore

Restore takes a backup and **never touches the live library**. It restores into a new folder,
`Application Support/lifelog-restores/backup-<first 16 hex of the manifest's SHA-256>`, laid out like the live
one. Merging into the live stores was rejected: raw receipts gate ACK, which is destructive, and owner data would
need conflict rules; a fresh folder cannot hurt anything.

1. Plan the backup as above (version, every hash, paths). Only listed files under `stores/` are copied, into a
   hidden staging folder.
2. Open the staged stores as the app would. Newer schemas fail closed. Every raw page is read and checked against
   its receipt's SHA-256; every cached conversation and sidecar decodes.
3. Only then rename the staging folder into place, so a restore folder exists only when complete.

A replay of the same backup finds its folder and writes nothing. The input is only read. Unsupported items
(conversation folders in a backup, unlisted files) are reported.

### Using a restored library

The owner chooses it in Backup & restore, after a confirmation that says what happens. Choosing queues, in the
restored source store, a rebuild of every playback file whose sidecar came back without its audio (the worker
rebuilds a sidecar without audio instead of skipping it; files evicted to save space wait until they are played), and schedules the switch. At the next launch, before
any store opens:

1. The live folder `Life` moves aside to `lifelog-previous-<unix time>`. It is never deleted.
2. The restored folder moves into its place.

If a step fails, the live folder is put back and the owner reads why in Backup & restore. The schedule is
consumed either way, so a failing switch does not retry at every launch.

## Old app

The old app's recordings were imported once, before the rebuild: each became a conversation marked `imported` with
its audio in `library/imported/<id>.m4a`, played from there and kept in backups (nothing can rebuild it). The cutover
sent them as conversations of source `import:<old id>`; the import itself is gone. The raw backup
sends their audio to the server's audio store.

## Versioning

A new field that old readers can ignore keeps v1. Anything else is v2, and v1 readers refuse it.
