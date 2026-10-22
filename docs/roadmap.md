# Roadmap

What Life is building next, in order, and what is parked. Each item gets its own plan in `docs/plans/` when it starts.

## Done

- The modules rework (October 2026): one contract each for inputs, outputs, model providers and secrets, a platform
  module, and one actions backend (Apple Reminders or Google Tasks). See the
  [platforms and modules plan](plans/2026-10-22-platforms.md).
- The move to Better-T-Stack: the repo re-scaffolded with its CLI, every route on Hono, and one connector change
  ([platforms and modules plan](plans/2026-10-22-platforms.md)).
- Life's own brand on every screen and email ([brand](brand.md)).
- lifelog's Android capture app: a minimal native Kotlin app that drains an Omi and uploads to the server.
- The architecture: dependencies point one way between layers, enforced by the check; `app/` and `worker/` became
  `apps/mac` and `apps/edge` ([architecture plan](plans/2026-10-22-architecture.md), [the code](architecture.md#the-code)).

- The agent roadmap (October 2026), from the review of how the agent gets its context: a model quota guard, one
  registry of source descriptors, a smaller connector payload and search, mail in search, context handed to the agent
  with each ask and its replies logged in the ledger, watcher and alert hygiene, the closure fix with done agent tasks
  as evidence, open items as one ranked, derived list synced both ways with the to-do list, the daily message, the
  first standing grant, birthday reminders, an end-to-end agent benchmark with a frozen clock, and the "hey Life"
  marker.
- Life's public address reaches the Mac over Tailscale Funnel, so it works behind a VPN.
- lifelog: sign-in codes go only to known callbacks, and the local server tests no longer hang.

## Now

- The naming pass: one word per concept ([glossary](glossary.md)), then the renames it plans, in three PRs: code-only
  names, stored names with their backfill (AGENTS.md, "A rename backfills"), the connector's tools in one batch.
- A one-time import of the owner's claude.ai and ChatGPT history: the reader is merged, and a scheduled task imports
  the exports once they land.

## Next

- A server version with a web UI ([server plan](plans/2026-10-22-server.md)). Life runs on a server as well as on a Mac, and has a web interface built with
  Better-T-Stack: Vite and Tailwind, signed in through Life's own issuer. People choose a Mac-only install or a full server.
- A rework of the memory layer: how sources become units, moments, observations and pages
  ([architecture](architecture.md)).
- OpenRouter as a model layer, beside the Claude and Codex subscriptions Life uses today.
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

- Keep rated facts when the memory is re-read, without reworded twins: one extraction rule under one prompt bump,
  checked on the 12–20 Oct facts. It unblocks re-reading 6 Sep to 13 Oct under today's prompts. Both wait for the
  model quota reset on 28 Oct.
- lifelog: name the other voices that land inside the owner's voice cluster, measured against the 22 Oct baseline.
- Proper logging: research a structured logging library and a local store that stays fast to query as years of logs
  pile up, then move every caller onto it and delete `core/log.ts`'s ad hoc path and the stray console calls.
- An investigation of how people are reconciled: how the index and the memory decide who is who (`memory/who.ts`,
  `people.ts`, `closeness.ts`, voice speakers). Much of it leans on voice; it should lean on each source's own
  identifiers (chat handles, phones, emails, mail headers). Findings and a fix, measured on real cases.

## Parked

- Windows. The platform module and the Windows fixes stay as seams; what a restart would need is at the end of the
  [platforms and modules plan](plans/2026-10-22-platforms.md).
- Search by meaning: tried and measured on 21 Oct, it did not improve answers and made each search about 23% bigger.
  The code is on the branch `claude/stage1b-embeddings-parked`; revisit only if the benchmark shows misses keyword
  search can't catch.
- A decision model for identity, tried locally and too heavy; a hosted model is the way back in.
- lifelog's app freeze: a watchdog now crashes the app on a freeze so the crash report names the cause. It becomes
  work only if the freeze returns.
- Mac screen time as a source ([life#82](https://github.com/eric-edouard/life/issues/82)).
- A send gateway: dropped, since the agent keeps its own send routes and Life already reads sent messages.
