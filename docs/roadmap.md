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

## Now

- The architecture: dependencies point one way between layers (core, capabilities, memory, host), enforced by the
  check, the import cycles gone, the schemas with their owners, then the repo's apps and packages
  ([architecture plan](plans/2026-10-22-architecture.md)).

## Next

- A naming pass over concepts and code: one glossary of Life's concepts (unit, moment, observation, page, plate,
  ledger, open item and the rest), each with one name used the same way in docs, the UI and the code, then files,
  types, functions and variables renamed to match. Done right after the architecture, before the server adds code
  that copies today's names. Names stored in the owner's memory (record kinds, unit ids) change only with a map, as
  AGENTS.md requires.
- A server version with a web UI ([server plan](plans/2026-10-22-server.md)). Life runs on a server as well as on a Mac, and has a web interface built with
  Better-T-Stack: Vite, Better Auth and Tailwind. People choose a Mac-only install or a full server.
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
