# One product: lifelog folds into Life (23 Oct 2026)

Life and lifelog become one product, Life, in one repo, this one. lifelog stays the name of the iPhone app that records
and transcribes the owner's conversations. This plan records the owner's decisions of 22–23 October and the order of
the move. Nothing is built yet.

## Why

Each half is little without the other: Life has no voice without lifelog, and lifelog without Life is a transcript
viewer whose summaries the owner doesn't use. Kept apart, they also carry two of several things: two people models
(lifelog's voices and Life's `truth/`), two OAuth issuers, two Mac apps with two supervisors, two tunnels, two backups,
two model runners on the same subscriptions, and two installs for a friend. One product is easier to understand and
removes those copies. The parts keep their own boundaries inside one repo: the phone, the Mac sensor and the servers
are separate apps, and the phone's invariants (ACK, paid once, dictation) stay in its own `AGENTS.md`.

## Decided

| Question | Decision |
|---|---|
| Product | One: Life. The iPhone app is named lifelog |
| Repo | lifelog's repo folds into this monorepo, then is retired |
| Transcription | On the server (or the Mac host), not on the phone, for now |
| Transcription on the iPhone | Parked: transcripts must come within minutes; iOS runs heavy work mostly while charging |
| Android | Parked (below) |
| lifelog's summaries | Life stops depending on them; they stay app UI only, or are turned off |
| Latency | A transcript within minutes of speech, so the agent can act on "hey <agent>" |
| lifelog's own server plan (lifelog #57) | Folded into Life's [server plan](2026-10-22-server.md) |

## Transcription on the server

ElevenLabs Scribe for every hour costs too much for the owner and for most people. lifelog's transcription bench
(lifelog `docs/research/transcription-bench.md`) found:

- English and French: Parakeet Ultra is as close to Scribe as anything measured (8.6% from it in English, 24.4% in
  French) and sometimes right where Scribe is wrong.
- Other languages (Thai, measured): no open model is good enough. VoxLingua107 finds them (3.1% of the Thai missed,
  combined with "Parakeet wrote nothing"), and only those turns go to Scribe: 15 to 25% of the audio.
- Speakers: pyannote credits 15.7% of words to another speaker than Scribe; Scribe run again with the language set
  differs from its own first run by 13.7%, so part of that gap is Scribe's own.

So the pipeline is diarization, then VoxLingua107 per turn, Parakeet Ultra for English and French, Scribe for the
rest. On the Mac host it runs through MLX (74× real time); on a server, on CPU through ONNX (sherpa-onnx exports the
NeMo checkpoint). The owner's target is a Hetzner CX43 at €12.49 a month (8 shared vCPU, 16 GB, no GPU); estimated,
not measured: 10–20 s for Parakeet and about 15 s for `diarize` per 2-minute block (pyannote about 100 s), about 4 GB
of RAM for every model, a transcript 2–3 minutes after speech. Scribe drops from about $50–65 to $10–15 a month at the
owner's volume. A transcription engine is one contract with two implementations (MLX, ONNX), chosen by the host, never
by a branch on its name.

### The benchmark, first

Before any code: rent a CX43 by the hour, run the bench's 70 clips through Parakeet Ultra (ONNX int8), `diarize`,
pyannote and VoxLingua107, measure speed and distance from Scribe, delete the box. Run from the owner's Mac (the clips
hold his voice and stay in his private notes); the clips leave the Mac for that hour only. Diarization variants
measured in the same run:

- **Drift splits:** speaker embeddings on sliding windows inside each turn (the ECAPA model `apps/identity` already
  runs); a turn whose voice drifts past a threshold is split where it drifts, then the pieces are clustered again.
  This catches a change of speaker the diarizer missed.
- **The owner's voice as an anchor:** his enrolled voice is known, so each turn is first scored against it. Owner
  versus everyone else is the split that matters most to the memory, and the easiest to get right.
- **Word times:** Parakeet's word timestamps move a speaker boundary to the nearest word gap instead of the middle of
  a word.

Each variant is kept only if it lowers the words credited to the wrong speaker on the multi-speaker clips.

## Life without lifelog's summaries

Today a lifelog chapter's title and summary (lifelog's model output) decide whether speech enters Life at all
(`no-summary`, `units.ts`), how it is cut into units (one per chapter), what the day's moment call reads, when a unit is
read again (its hash) and what search and the Past calendar show. Facts already come from the words (`voiceLines`).

Instead, units come from lifelog's conversations (grouped by rules, no model) and their turns, cut by Life's own rule;
the gate is "transcribed"; a unit's text for the moment call is the head and tail of its words, as `TEXT_MAX` clips
other units; search and the calendar show Life's own moments. The chapter fields Life stores and the `no-summary`
rule go. Unit ids change recipe, so it ships with a migration (`host/migrate.ts`, the owner's OK on the list), and new
units apply from a cutover date so the voice history isn't read again through the models.

## Storage: which SQLite files

One SQLite file per writer is the norm, not a mess: SQLite allows one writer at a time, and each file here has its own
writer, life and backup. Merging them would put two processes behind one lock for nothing. So:

- lifelog's archive (`archive.sqlite`): one file, one writer, the lifelog server. Unchanged.
- Life's archive of deleted messages and note versions (one file per source): unchanged, never migrated.
- Life's search index (`index.sqlite`): derived, rebuilt.
- Life's lifelog store (`derived/watch/lifelog.sqlite`): a copy of lifelog's feed. This one is a duplicate once both
  live in one repo on one host. Life's voice source then reads lifelog's archive read-only, as lifelog's own scripts do,
  and the copy is deleted.

## The move

1. **Transcription on the server.** The benchmark above, then the engine contract, the ONNX engine and VoxLingua
   routing in lifelog's server, behind a switch: off is today's Scribe path. Both write the same transcript shape, so
   the feed and Life don't change.
2. **Life stops depending on summaries** (above).
3. **The repo folds in.** lifelog's apps move under `apps/` (`apps/lifelog-ios`, `apps/lifelog-server`, the Mac sensor,
   `apps/identity`; names decided in that PR, with their glossary lines), with their history, its checks joining
   `bun run check`. lifelog's repo is archived.
4. **People move to Life.** The phone's "Who's this?" names voices into Life's people, so `truth/` and the voices are
   one model.
5. **The copies go:** Lifelog Host (Life.app runs the lifelog server and the dictation sensor on a Mac-only install),
   lifelog's OAuth issuer (`packages/auth`; Life's own issuer serves the connector, in the next batched reconnect), the
   second runner, the second tunnel and backup, the feed copy above.

## Android, parked

lifelog's Android app (Kotlin) drains an Omi and sends raw pages, which the server labels and cuts by the iPhone's
rules. It is parked: the owner uses an iPhone, the move above changes the server it talks to, and keeping a second
phone app working through it costs more than it serves today. Its code stays in `apps/` and builds; nothing new lands
in it until it is picked up again.

## On-device transcription, parked

Parakeet Ultra runs on the iPhone (FluidInference's Core ML build, iOS 17+, the Neural Engine), and audio could then
stay on the phone and in the owner's iCloud. Parked because the system needs transcripts within minutes, and iOS
gives heavy background work time mostly while charging. Still unknown: its speed and battery cost on an iPhone,
VoxLingua107 on Core ML, and audio past its 15-second window.
