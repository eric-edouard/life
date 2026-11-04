# Roadmap

What Life is building next, in order, and what is parked. Each item gets its own plan in `docs/plans/` when it starts.

## Done

- The modules rework (October 2026): one contract each for inputs, outputs, model providers and secrets, a platform
  module, and one actions backend (Apple Reminders or Google Tasks). See the
  [platforms and modules plan](plans/2026-10-22-platforms.md).
- Nice to have, lifelog: wake phrases on the phone. Speech the app already labels is transcribed on the device in
  English (`SpeechTranscriber`); phrases the owner lists ("Hey Claude", "Hey ChatGPT", any number) each run their action
  with the words after them: a Shortcut, Claude or ChatGPT. A request ends at a pause, checked by Foundation Models
  ("complete or still waiting?") where Apple Intelligence is on. Found on 23 Oct: iOS runs no Shortcut from the
  background, so there it is a notification and one tap, as a button press is (it goes through `ButtonActions`); the
  phone can't tell voices apart; Foundation Models is rate-limited in the background; Mac dictation must stay out;
  it overlaps Life's own "hey <agent>". First step when picked up: an hour of Pendant audio on the phone, for battery
  and delay.
- The move to Better-T-Stack: the repo re-scaffolded with its CLI, every route on Hono, and one connector change
  ([platforms and modules plan](plans/2026-10-22-platforms.md)).
- Life's own brand on every screen and email ([brand](brand.md)).
- lifelog's Android capture app: a minimal native Kotlin app that drains an Omi and uploads to the server.
- The architecture: dependencies point one way between layers, enforced by the check; `app/` and `worker/` became
  `apps/mac` and `apps/edge` ([architecture plan](plans/2026-10-22-architecture.md), [the code](architecture.md#the-code)).
- The agent roadmap (October 2026): context handed to the agent with each ask, the model quota guard, one registry
  of source descriptors, the closure fix, the daily message and an end-to-end agent benchmark.
- Life's public address reaches the Mac over Tailscale Funnel, so it works behind a VPN.
- lifelog: sign-in codes go only to known callbacks, and the local server tests no longer hang.
- The web app (October 2026): `apps/web` (Vite, React, Tailwind, TanStack Router and Query), its sign-in, and the
  decisions page rebuilt to fit any screen without covering or nesting scrolls ([architecture](architecture.md#pages)).

## Now

- The naming pass: one word per concept ([glossary](glossary.md)), then the renames it plans, in three PRs: code-only
  names, stored names with their backfill (AGENTS.md, "A rename backfills"), the connector's tools in one batch.
- A one-time import of the owner's claude.ai and ChatGPT history: the reader is merged, and a scheduled task imports
  the exports once they land.

## Next

- A server version with a web UI ([server plan](plans/2026-10-22-server.md)). Life runs on a server as well as on a Mac, and has a web interface built with
  Better-T-Stack: Vite and Tailwind, signed in through Life's own issuer. People choose a Mac-only install or a full server.
  The web app is in (`apps/web`); next in it: the pairing page, then the coming pages. With them: Hono's typed client
  for `/api/` (end-to-end types, no new layer), file-based routes from about six pages, and whether `bts.jsonc` stays
  (only Better-T-Stack's `add` reads it). Not taken from Better-T-Stack: oRPC or tRPC (a third way to define an
  endpoint), Better Auth (a second issuer), Turborepo. Before relying on the keyboard layout: one pass on his iPhone
  (the layout check runs Chromium only).
- A rework of the memory layer: how sources become units, moments, observations and pages
  ([architecture](architecture.md)).
- Two release channels from one codebase: the Mac app and the server.
- A release pipeline: publishing a release ships the update to every install, the Mac app through its updater
  ([releasing](releasing.md)) and the server alike.
- Onboarding, scoped for both the Mac and the server: the first-run experience and connecting each source and
  assistant.
- An investigation of on-device transcription: what speech models running on the phone or the Mac can do (accuracy,
  speakers, languages, battery), compared with lifelog's cloud transcription.
- A comparison of cloud transcription providers for Thai, beyond ElevenLabs Scribe: Microsoft MAI-Transcribe 1.5,
  Google Chirp 3, Soniox and AssemblyAI Universal, run on the same recordings for accuracy, speakers, mixed Thai and
  English, price and latency.
- No reworded twins of rated facts on a re-read (a re-read already keeps a fact the owner rated true): one extraction rule
  under one prompt bump, checked on the 12–20 Oct facts. The rule and the re-read of 6 Sep to 13 Oct it unblocks wait
  for the model quota reset on 28 Oct.
- lifelog: name the other voices that land inside the owner's voice cluster, measured against the 22 Oct baseline.
- Proper logging: research a structured logging library and a local store that stays fast to query as years of logs
  pile up, then move every caller onto it and delete `core/log.ts`'s ad hoc path and the stray console calls.
- An investigation of how people are reconciled: how the index and the memory decide who is who (`memory/who.ts`,
  `people.ts`, `closeness.ts`, voice speakers). Much of it leans on voice; it should lean on each source's own
  identifiers (chat handles, phones, emails, mail headers). Findings and a fix, measured on real cases.

## Parked

- The portrait (`/me`): a one-off, served as it is behind his sign-in; deleted when it stops being fun.

- Windows. The platform module and the Windows fixes stay as seams; what a restart would need is at the end of the
  [platforms and modules plan](plans/2026-10-22-platforms.md).
- Search by meaning: tried and measured on 21 Oct, it did not improve answers and made each search about 23% bigger.
  The code is on the branch `claude/stage1b-embeddings-parked`; revisit only if the benchmark shows misses keyword
  search can't catch.
- A decision model for identity, tried locally and too heavy; a hosted model is the way back in.
- lifelog's app freeze: a watchdog now crashes the app on a freeze so the crash report names the cause. It becomes
  work only if the freeze returns.
- A send gateway: dropped, since the agent keeps its own send routes and Life already reads sent messages.
