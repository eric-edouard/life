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

## Now

- The naming pass: one word per concept ([glossary](glossary.md)), then the renames it plans, in three PRs: code-only
  names, stored names with their backfill (AGENTS.md, "A rename backfills"), the connector's tools in one batch.

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

## Parked

- Windows. The platform module and the Windows fixes stay as seams; what a restart would need is at the end of the
  [platforms and modules plan](plans/2026-10-22-platforms.md).
