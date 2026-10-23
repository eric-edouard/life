# Playbook: Life on a server, one repo (23 Oct 2026)

How the [one product plan](2026-10-23-one-product.md) and the [server plan](2026-10-22-server.md) get finished: the
order, who does each step, what each step must prove, and what needs the owner. Agents work from this file; a step
that changes it updates it in the same PR.

Two routes stay first-class, from one codebase: the **Mac host** (Life.app runs everything on the Mac) and the
**server** (Docker Compose on a VPS, the Mac optional). A step that serves one route keeps the other working.

## Decided (23 Oct)

| Question | Decision |
|---|---|
| Repo | Life, private. lifelog's code comes in as one commit, without its history |
| First move off the Mac | Voice and the core: the voice server, transcription, memory, connector, nightly, mail, Google Tasks. The Mac companion keeps feeding iMessage, WhatsApp, Beeper and Notes until the bridges land |
| Life's model calls on the server | OpenRouter with an API key, DeepSeek V4.1 Flash (`deepseek/deepseek-v4.1-flash`) |
| Transcription | Nemotron diarization, VoxLingua107 per turn, Parakeet Ultra (ONNX fp32 on CPU, MLX on the Mac), Scribe for the rest |
| Host | OVHcloud VPS-2, Singapore; Hetzner CX33 the fallback |
| Reaching it | A Cloudflare Tunnel on the box: `life.` and `voice.` on the owner's domain; no open port, administration over Tailscale |
| Storage | The VPS disk; restic, encrypted, to Backblaze B2 or Cloudflare R2 |
| Deploy | Built on the box: a script pulls `main` and runs `docker compose up -d --build`. No CI, no registry |
| Mac route | Life.app runs the voice server, the speech service and the dictation sensor; Lifelog Host is retired |
| Names | lifelog goes everywhere: the iPhone app is Life; its server the voice server, the models the speech service ([one product plan](2026-10-23-one-product.md#names)) |
| Merging | A PR merges by itself once `bun run check` and the `debt-review` skill pass, except the ask-first items below |

### Ask first, still

Merging on a green review never covers these; each waits for the owner's yes in conversation:

- a migration of stored data (the list of renames), and re-running anything over the whole archive through a model;
- a new table in either archive;
- a connector change (one reconnect, batched);
- `docs/agent.md`;
- anything that leaves the host that SECURITY.md doesn't list yet;
- the cutover itself, and anything on the owner's phone.

## Before the first step (owner)

1. Make `eric-edouard/life` private (GitHub, Settings, General, Danger Zone). It is public today.
2. Order the OVH VPS-2 in Singapore (Ubuntu 24.04), and add it to his tailnet.
3. An OpenRouter key, with data collection denied and zero data retention in its privacy settings.
4. A B2 or R2 bucket and its keys; a new restic password kept in his password manager, never on the server.
5. A Cloudflare Tunnel for the box, with routes `life.<domain>` → `life:46200` and `voice.<domain>` → `voice:3000`.

## Who does what

- **Cloud sessions** do the code that runs on Linux: the server, the Compose, the speech service, the docs. Swift and
  Xcode steps report "skipped: needs macOS" there, never pass silently.
- **A local session on the Mac** does what needs the Mac or his data: Swift builds, the phone, the measurements on his
  clips, the box, the cutover.
- One step at a time per area; a session reads this file and the step's plan section first, and ends with the
  debt-review verdict in its PR.

## The steps

Each step is one PR or a short series, merged before the next one starts unless it says otherwise.

### 1. lifelog comes into the repo

- lifelog's `main` at one commit lands under `apps/`, named as the [one product plan](2026-10-23-one-product.md#names)
  says: `apps/ios` (the app shows the name Life), `apps/voice` with its `packages/db` and `packages/auth` inside it,
  the dictation sensor and Lifelog Host beside `apps/mac` until step 9, `apps/android` (parked), `apps/speech`. Each
  name gets its glossary line, and no file, type, doc or string says lifelog but the stored names of step 4.
- Its checks join `bun run check`; its `AGENTS.md` files move beside their apps, its invariants (ACK, paid once,
  dictation, one archive writer, no secrets on a command line) unchanged.
- `scripts/scrub-check.ts` scrubs the new apps too; lifelog's own copy of the path goes.
- Done when: the check is green on the Mac (Swift included) and on Linux (Swift skipped, said so); the lifelog repo is
  archived with a pointer to Life.

### 2. One speech service

`apps/identity` (SpeechBrain ECAPA) and the new models are the same kind of thing: audio in, numbers out, no storage.
One Python service does all of it: speaker embeddings, VoxLingua107, Nemotron diarization, Parakeet Ultra.

- One HTTP contract, two runtimes: CPU on a server (Transformers, onnx-asr fp32; never int8: it drops up to 87% of the
  words), MLX and NeMo-Speech.cpp on Metal on the Mac. The host picks the runtime; nothing branches on a name.
- Done when: the bench's results reproduce through the service on both runtimes (the local session runs it on his
  clips; the numbers go to the bench write-up, never his audio). The CPU proof of concept that produced them (one
  script per model, the box run, its lockfile) is in his notes beside the clips, `lifelog/stt-bench/cpu/`: a reference
  for the CPU runtime, not code to copy (it loads each model in three scripts).

### 3. Transcription moves to the speech service

- The voice server's job worker sends a closed block to the speech service, routes the turns VoxLingua finds neither
  English nor French (or Parakeet left empty) to Scribe, a block 70% routed whole. Behind a switch: off is today's
  Scribe path.
- The transcript shape stays, so the phone, the feed and Life don't change. Paid once still holds for Scribe's part;
  dictation is still cut before any model hears it.
- Done when: a day of real speech runs with the switch on, on the Mac route, and the owner's spot check of a few
  conversations finds nothing worse.

### 4. Life stops depending on lifelog's summaries

The stored names (the source `lifelog` → `voice`, its setting and token, [Names](2026-10-23-one-product.md#names))
ride in the same migration.

As the [one product plan](2026-10-23-one-product.md#life-without-lifelogs-summaries) says. Ask first: the migration's
list, and the cutover date for the new units.

- Then the voice server's model runner and summaries are off by default; the phone shows conversations without them.
- Done when: a measured day (moments and extraction, `docs/operations.md`, "Measuring") is no worse than before.
- Built: a voice unit is one transcribed conversation's turns on one local day; its words are fetched for the day being
  read (`voiceText`), the moment call sees their head and tail. The cutover is the day the migration runs (his install moves only when
  he installs the new Life.app, at the end): chapter units before it stay as stored; a fresh install has none. The `ai` switch is summaries only, off by default; search follows the OpenAI key. Life keeps reading the
  feed over HTTP (one way on one host or two). The status reads keep `lifelog` connector names for the next batched
  connector change.

### 5. Life runs headless on Linux

- A headless entry (the services Life.app supervises, without the app), Linux paths in `platform.ts`, the Codex test
  made Mac and Windows only.
- OpenRouter as a provider in `PROVIDERS` for every step, not the bench alone: DeepSeek V4.1 Flash, pinned to a host
  that keeps no data (`author/model@host`). The invariant "model calls use the owner's subscriptions" becomes "on the
  Mac host; on a server, OpenRouter", in AGENTS.md and SECURITY.md in the same PR.
- Network sources: IMAP or the Gmail API, Google Tasks, contacts through CardDAV or Google, git from the forge.
- Life's own OAuth issuer serves the connector on the server.
- Done when: a copy of the data runs a full night (sweep, moments, extraction, pages, the nightly email) in a
  container on Linux, and the connector answers.
- Built (23 Oct): `bun life headless` (the container's command), Linux paths and Mac-only capabilities in
  `platform.ts`, `openrouter` as an engine (DeepSeek V4.1 Flash, zero retention, the default on Linux), the server's
  keys in `LIFE_STATE_DIR/secrets.env`, locks that survive a container's restart. Network sources are their own
  session's.

### 6. The Mac companion

Life.app's second mode, pointed at a server: it reads the Mac-only sources (iMessage, WhatsApp, Beeper, Apple Notes)
and the archive's copies and pushes them to the hub, and runs the dictation sensor. The push contract is designed in
this step's PR; the archive keeps its rule (never moved, never rewritten): the hub gets a copy.

- Done when: a message sent on the Mac shows in the hub's memory within minutes, and one deleted after it stays
  archived.

### 7. The server's Compose

`deploy/compose.yaml`: `life`, `voice`, `speech`, `tunnel` (cloudflared). Volumes for the data repo, both archives,
the voice server's audio and restic's staging; secrets from a 0600 env file outside the repo; restic to the bucket
(one bucket, two repositories). `deploy/update.sh` pulls `main` and rebuilds. A `docs/use/server.md` how-to.

- Done when: on the OVH box with a scratch install, the 10-minute end-to-end check passes (speech in, transcript out
  in under 3 minutes, peak RAM in budget), and a restore from the bucket works.

### 8. The cutover (local session, the owner present)

A runbook in the shape of the names rollout (`2026-10-23-names-rollout.md`), written in this step:

1. The first full restic backup goes from the Mac (OVH's plan caps traffic outside Asia-Pacific).
2. Stop the Mac's services. Copy the data repo and Life's archive (copied, never moved), and the voice server's
   archive through its `export` and `import`.
3. Move the tunnel's routes to the box; the phone keeps its address. The dictation sensor points at the server.
4. The connector moves to Life's issuer on the server: one reconnect in ChatGPT and Claude.
5. Life.app switches to companion mode.
6. Check: status, a conversation spoken and found in memory, the nightly the next morning. Rollback: stop the box,
   point the routes back, restart Life.app in full mode.

### 9. What goes

Lifelog Host, the voice server's `packages/auth`, its model runner and summaries code, the second tunnel and backup,
the names migration (`host/migrate.ts`'s step, once his data shows it ran), the plans this playbook finished. Life's
voice store stays: Life reads the voice server through its API only (step 4).

### Later

Messaging through bridges and iMessage (the [server plan](2026-10-22-server.md), phases 2–3), files, one-click
installs, Android.

## Open

- DeepSeek V4.1 Flash for the memory steps is unmeasured: the bench (`bun scripts/bench.ts`) runs it against today's
  models before step 5 merges, on the owner's yes (it spends quota).
- Which OpenRouter host serves DeepSeek with no retention, and its price at the owner's volume.
- The OVH box's real RAM: 5.1 GB of models plus Life on 8 GB is tight. fp16 doesn't help on CPU (6.0 GB, no faster), so
  the 10-minute check measures Life's own share there; if it doesn't fit, the next OVH size up, not a smaller model.
