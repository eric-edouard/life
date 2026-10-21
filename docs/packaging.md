# Packaging

Life as a Mac app friends install and run on their own Mac, connected by Tailscale, with no server of their own.
The full review, the reasons and the owner's decisions (22 Oct): `~/Life/docs/reviews/2026-10-22-packaging/index.html`.

How it lands: every item is its own PR into the `packaging` branch, merged only after a passing golden-rule review
(`debt-review`). The `packaging` branch reaches `main` as one PR, with its deploy steps, on the owner's OK. lifelog runs
the same process in its own repo.

## Phase 1: Life core

- [ ] 1.2 One settings file (`src/settings.ts`); every owner value read from it, none in code. Folds in 1.1 (retired
  paths: `LIFE_CHAT` no longer required).
- [ ] 1.3 `derived/` and the data root under Application Support for a new install; `isHis` by a marker, not a path.
- [ ] 1.4 `bun life init`: an empty, valid `truth/`, Goals optional, zones seeded, the data repo created.
- [ ] 1.5 Sources: `needs`, `probe`, the enabled set. A source not set up never fails the night; zero sources runs a
  clean night.
- [ ] 1.6 Voice as a registry capability: no lifelog special cases in `gather`, `search.day` or the watcher.
- [ ] 1.7 Archive stores as descriptors: only enabled, installed apps kept open.
- [ ] 1.8 Handles as a record keyed by source (schema first).
- [ ] 1.9 Notification sink: macOS notification and in-app report by default, email optional.

## Phase 2: agents and sign-in

- [ ] 2.1 Agent settings (name, wake words, misheard, clients); `atlas` target becomes `agent`, old lines parse.
- [ ] 2.2 Transport interface: `mcp-event`, `pull`, `webhook`, `command`.
- [ ] 2.3 Playbook split: the shipped protocol and the user's own part.
- [ ] 2.4 Life's own authorization server, pairing-code approval, CIMD then DCR.
- [ ] 2.5 Tailscale: Serve for the tailnet, Funnel opt-in for cloud agents; the tunnel healer only for Cloudflare.

## Phase 3: Life.app

- [ ] 3.1 One compiled helper (`bun build --compile`): archive, watcher and nightly as workers.
- [ ] 3.2 SwiftUI menu-bar app: spawns and supervises the helper, login item, settings.
- [ ] 3.3 Onboarding: who you are, engine, sources with Full Disk Access guidance, agents.
- [ ] 3.4 Reminders and the calendar projection through EventKit; `remctl` stays the owner's backend.
- [ ] 3.5 Engines: Codex, API keys, Claude (`claude -p`, advanced).
- [ ] 3.6 Release: Developer ID, notarization, Sparkle, one DMG with Life.app and Lifelog Host.

## Deploy steps when `packaging` reaches `main`

- Write the owner's `derived/settings.json` from his `.env` and the values that were constants: `connector` (origin,
  issuer, client, owner), `lifelog.url`, `mail`, `lifeChat`, `misheard`, `past`, `reports`, `repos: "~/Work"`,
  `backup` (iCloud restic repository, `security find-generic-password -s life-restic -w`), `sources` (every source he
  reads today: lifelog, imessage, whatsapp, beeper, mail, notes, claude, chatgpt, atlas, git), and keep `engine`.
- Remove the moved keys from `.env` (`LIFE_OWNER_SUB`, `LIFE_MAIL_TO`, `LIFE_CHAT`, `LIFE_MISHEARD`, `LIFE_PAST_*`,
  `LIFELOG_URL`) and the parked `TELEGRAM_*` and `INSTINCT_KEY`.
- Add the status Worker's new secret, `ISSUER` (`wrangler secret put ISSUER`, the connector's issuer), then redeploy it.
