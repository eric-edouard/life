# One product: lifelog folds into Life (23 Oct 2026)

Life and lifelog become one product, Life, in one repo, this one. The name lifelog goes: the iPhone app that records
and transcribes the owner's conversations is called Life, like everything else ("Names", below). This plan records the
owner's decisions of 22–23 October and the order of the move. Nothing is built yet.

## Why

Each half is little without the other: Life has no voice without lifelog, and lifelog without Life is a transcript
viewer whose summaries the owner doesn't use. Kept apart, they also carry two of several things: two people models
(lifelog's voices and Life's `truth/`), two OAuth issuers, two Mac apps with two supervisors, two tunnels, two
backups, two model runners on the same subscriptions, and two installs for a friend. One product is easier to
understand and removes those copies. The parts keep their own boundaries inside one repo: the phone, the Mac sensor
and the servers are separate apps, and the phone's invariants (ACK, paid once, dictation) stay in its own `AGENTS.md`.

## Decided

| Question | Decision |
|---|---|
| Product | One: Life. The iPhone app is named Life too; the name lifelog goes everywhere |
| Repo | lifelog's repo folds into this monorepo, then is retired |
| Transcription | On the server (or the Mac host), not on the phone, for now |
| Transcription on the iPhone | Parked: transcripts must come within minutes; iOS runs heavy work mostly while charging |
| Android | Parked (below) |
| lifelog's summaries | Life stops depending on them; they stay app UI only, or are turned off |
| Host | OVHcloud VPS-2, Singapore; Hetzner CX33 as fallback |
| Latency | A transcript within minutes of speech, so the agent can act on "hey <agent>" |
| lifelog's own server plan (lifelog #57) | Folded into Life's [server plan](2026-10-22-server.md) |

## Transcription on the server

ElevenLabs Scribe for every hour costs too much for the owner and for most people. Measured on 70 two-minute clips of
the owner's recordings, against Scribe's stored transcript (distances from Scribe, not error rates; lifelog
`docs/research/transcription-bench.md`, with its CPU section):

| Step | Model | Result |
|---|---|---|
| Speakers | NVIDIA Nemotron-3-Diarization | 8.5–8.9% of words credited to another speaker than Scribe (pyannote community-1: 15.7%; Scribe against itself: 13.7%) |
| Language, per turn | VoxLingua107 | Neither English nor French, or Parakeet wrote nothing: to Scribe. 1.6% of Thai seconds missed, 15.4% of English and French sent needlessly |
| English and French | Parakeet Ultra | 8.6% English, 24.5% French, 20.2% mixed: the best open model, sometimes right where Scribe is wrong |
| Everything else | Scribe, language on auto | 15 to 25% of the audio; a block 70% routed goes whole |

No open model is good enough on Thai, hence Scribe for the rest: about $10–15 a month instead of $50–65 at the owner's
volume.

**On a CPU server** (measured on an 8 shared vCPU AMD EPYC box, Ubuntu 24.04): Parakeet Ultra runs as ONNX fp32
(onnx-asr, CPU), within 0.3 points of MLX; int8 exports drop up to 87% of the words and are never used. Nemotron runs
through Hugging Face Transformers on CPU (NeMo-Speech.cpp is the lighter runtime, not yet timed). One 2-minute block,
every model loaded in one process: about 12 s on 8 threads, 17 s on 4, 27 s on 2, so a transcript lands 1–3 minutes
after speech, upload included. Peak RAM 5.1 GB (Parakeet fp32 alone 3.9 GB; fp16 being measured). **On the Mac host**
the same pipeline runs through MLX (Parakeet about 74× real time) and NeMo-Speech.cpp on Metal (Nemotron about 240×).
A transcription engine is one contract with two implementations, chosen by the host, never by a branch on its name.

**Rejected** on top of Nemotron, none better than its 8.9%: splitting turns where the voice drifts (ECAPA windows,
9.9%), the owner's enrolled voice as an anchor (16.3%: it credits others to him), boundaries snapped to Parakeet's
word gaps (9.0%).

**The host** needs 4 vCPU (2 work), 8 GB of RAM with Life, x86; its location barely matters at minutes of latency.
Decided: OVHcloud VPS-2 in Singapore (4 vCPU, 8 GB, about $8.50 a month, managed by API); Hetzner CX33 (€10.19) is the
fallback. Shared cores vary, so a 10-minute end-to-end check runs on the box first.

## Life without lifelog's summaries

Today a lifelog chapter's title and summary (lifelog's model output) decide whether speech enters Life at all
(`no-summary`, `units.ts`), how it is cut into units (one per chapter), what the day's moment call reads, when a unit
is read again (its hash) and what search and the Past calendar show. Facts already come from the words (`voiceLines`).

Instead, units come from lifelog's conversations (grouped by rules, no model) and their turns, cut by Life's own rule;
the gate is "transcribed"; a unit's text for the moment call is the head and tail of its words, as `TEXT_MAX` clips
other units; search and the calendar show Life's own moments. The chapter fields Life stores and the `no-summary` rule
go. Unit ids change recipe, so it ships with a migration (`host/migrate.ts`, the owner's OK on the list), and new
units apply from a cutover date so the voice history isn't read again through the models.

## Storage: which SQLite files

One SQLite file per writer is the norm, not a mess: SQLite allows one writer at a time, and each file here has its own
writer, life and backup. Merging them would put two processes behind one lock for nothing. So:

- The voice server's archive (`archive.sqlite`, lifelog's today): one file, one writer. Unchanged.
- Life's archive of deleted messages and note versions (one file per source): unchanged, never migrated.
- Life's search index (`index.sqlite`): derived, rebuilt.
- Life's lifelog store (`derived/watch/lifelog.sqlite`): a copy of lifelog's feed. This one is a duplicate once both
  live in one repo on one host. Life's voice source then reads lifelog's archive read-only, as lifelog's own scripts
  do, and the copy is deleted.

## The move

The [server playbook](2026-10-23-server-playbook.md) orders these with the server's steps, and is what agents work
from.

1. **Transcription on the server.** The engine contract, its MLX and ONNX engines, Nemotron and VoxLingua routing in
   the voice server, behind a switch: off is today's Scribe path. Both write the same transcript shape, so the feed
   and Life don't change.
2. **Life stops depending on summaries** (above).
3. **The repo folds in.** lifelog's apps move under `apps/` with the names below, with their history, its checks
   joining `bun run check`. lifelog's repo is archived.
4. **People move to Life.** The phone's "Who's this?" names voices into Life's people, so `truth/` and the voices are
   one model.
5. **The copies go:** Lifelog Host (Life.app runs the voice server and the dictation sensor on a Mac-only install),
   lifelog's OAuth issuer (`packages/auth`; Life's own issuer serves the connector, in the next batched reconnect),
   the second runner, the second tunnel and backup, the feed copy above.

## Names

The name lifelog goes from the product, the code, the docs and the stored data. Each part is named for what it is
(proposed; the glossary lines land with the PR that brings each part in):

| Today | Becomes | Where |
|---|---|---|
| lifelog, the iPhone app (and its Watch app, widgets, `Kit/`) | Life, the iPhone app | `apps/ios` |
| lifelog's server (audio, jobs, conversations, speakers, one SQLite file) | the voice server | `apps/voice` |
| `apps/identity` and the new speech models | the speech service | `apps/speech` |
| lifelog-quiet, the Mac helper | the dictation sensor, inside Life.app | `apps/mac` |
| Lifelog Host | retired: Life.app runs the voice server | |
| lifelog's Android app | Life for Android, parked | `apps/android` |
| The source `lifelog`, the `lifelog` setting, `LIFELOG_TOKEN`, `derived/watch/lifelog.sqlite` | `voice`, `VOICE_TOKEN`; the feed copy is deleted (step 5) | stored: in the summaries migration, on the owner's OK |
| `lifelog.<domain>` | `voice.<domain>` | the tunnel |
| The lifelog repo | archived | |

The phone's bundle id and its Keychain items keep their stored values until a release can move them without losing the
pairing; the name the owner sees changes at once.

## Android, parked

lifelog's Android app (Kotlin, Life for Android once it is picked up) drains an Omi and sends raw pages, which the
server labels and cuts by the iPhone's rules. It is parked: the owner uses an iPhone, the move above changes the
server it talks to, and keeping a second phone app working through it costs more than it serves today. Its code stays
in `apps/` and builds; nothing new lands in it until it is picked up again.

## On-device transcription, parked

Parakeet Ultra runs on the iPhone (FluidInference's Core ML build, iOS 17+, the Neural Engine), and audio could then
stay on the phone and in the owner's iCloud. Parked because the system needs transcripts within minutes, and iOS gives
heavy background work time mostly while charging. Still unknown: its speed and battery cost on an iPhone, VoxLingua107
on Core ML, and audio past its 15-second window.
