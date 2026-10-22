# Packaging

Life as a Mac app friends install and run on their own Mac, connected by Tailscale, with no server of their own.
The full review, the reasons and the owner's decisions (22 Oct): `~/Life/docs/reviews/2026-10-22-packaging/index.html`.

How it lands: every item is its own PR into the `packaging` branch, merged only after a passing golden-rule review
(`debt-review`). The `packaging` branch reaches `main` as one PR, with its deploy steps, on the owner's OK. lifelog runs
the same process in its own repo.

## Phase 1: Life core

- [x] 1.2 One settings file (`src/settings.ts`); every owner value read from it, none in code. Folds in 1.1 (retired
  paths: `LIFE_CHAT` no longer required).
- [x] 1.3 One state root (`LIFE_STATE`) beside the data root (`LIFE_DATA`): the app sets both under Application Support.
- [x] 1.4 `bun life init`: an empty, valid `truth/`, Goals optional, zones seeded, the data repo created.
- [x] 1.5 Sources: the `sources` setting, each descriptor's `missing`, the ready set. A source not set up never fails the night; zero sources runs a
  clean night.
- [x] 1.6 Life without a voice source: the watcher, `day`, search and the nightly run with lifelog off (a voice interface waits for a second voice source: Omi comes through lifelog).
- [x] 1.7 Archive stores as descriptors: only enabled, installed apps kept open.
- [~] 1.8 dropped: the fixed handle kinds cover every source the app ships.
- [x] 1.9 Notification sink: macOS notification and in-app report by default, email optional.

## Phase 2: agents and sign-in

- [x] 2.1 Agent settings (name, wake words, misheard, client, transport); every "Atlas" Life writes comes from them; the stored words (`target: "atlas"`, `waiting-eric`) stay.
- [x] 2.2 Transports: `mcp-event` and `pull` (webhook and command wait for an agent that needs them).
- [x] 2.3 Playbook split: the shipped protocol and the user's own part.
- [x] 2.4 Life's own authorization server, pairing-code approval, CIMD then DCR.
- [x] 2.5 Tailscale: Serve for the tailnet, Funnel opt-in for cloud agents; the tunnel healer only for Cloudflare.

## Phase 3: Life.app

- [x] 3.1 One compiled helper (`bun build --compile`) with its files; the app runs archive, watcher and nightly from it.
- [x] 3.2 SwiftUI menu-bar app: spawns and supervises the helper, login item, settings.
- [x] 3.3 Onboarding: who you are, engine, sources with Full Disk Access guidance, agents.
- [x] 3.4 The calendar projection through EventKit; Reminders through `remctl` for every install (transition R1).
- [x] 3.5 Engines: Codex, API keys, Claude (`claude -p`, advanced).
- [x] 3.6 Release: Developer ID, notarization, Sparkle (chosen over AppUpdater, 22 Oct: EdDSA-signed updates, a tested
  update window), one DMG with Life.app and Lifelog Host, published in a public releases-only repo.

## Deploy steps when `packaging` reaches `main`

In this order: the live tree (`~/Work/life`) runs the archive, the watcher and the nightly, and the new code with his
current settings (`engine` only) reads no source at all: the archive would stop keeping WhatsApp, Beeper and Notes, the
only copy of what gets deleted.

1. Before pulling, write the owner's `derived/settings.json` (main's code ignores the new keys) from his `.env` and the
   values that were constants on main (`git show origin/main:<file>`): `connector` (origin, issuer, client and owner
   from `src/auth.ts`, and `tunnel: "cloudflare"`, or the healer stops), `lifelog.url` (`LIFELOG_URL`, or main's default
   in `src/sources/lifelog.ts`), `mail` (`from`
   in `src/memory/email.ts`, `to` = `LIFE_MAIL_TO`), `lifeChat` (`LIFE_CHAT`: unset, Life's old bot would read as
   facts), `past` (`LIFE_PAST_*`), `reports` (the agents' report senders in `src/memory/units.ts`), `repos: "~/Work"`,
   `backup` (iCloud restic repository, `security find-generic-password -s life-restic -w`), `sources` (every source he
   reads today: lifelog, imessage, whatsapp, beeper, mail, notes, claude, chatgpt, atlas, git), `agent` (`{name:
   "Atlas", wake: ["atlas"], misheard: ["at last", <LIFE_MISHEARD>], client: "openai-mcp"}`: without it nothing wakes
   and `act` no longer refuses his Atlas list), and keep `engine`. Until the pull, never run `bun life engine`: main's
   rewrites the file with the engine alone.
2. Pull, then at once `bun install` (the new code imports `@anthropic-ai/sdk`: until it is there the watcher and the
   archive, restarted on the new code, fail to start), then `bun life settings` from `~/Work/life` (it validates the
   file) and `bun life status`.
3. Restart the watch and the archive, which read their settings once: `launchctl kickstart -k gui/$(id -u)/<label>`
   (labels in `src/mac.ts`). Not the nightly: each tick is a new process with the new settings, and a running one is
   left to finish. Check `actions: remctl ready` in `~/Library/Logs/life-watch.log` and that the archive's stores are
   copying.
- Move his own part of the playbook from `~/Life/docs/packaging/playbook.md` to `~/Life/playbook.md` (audits, his plan,
  what his Mac reaches, his send accounts: without it Atlas loses them).
- Remove the moved keys from `.env` (`LIFE_OWNER_SUB`, `LIFE_MAIL_TO`, `LIFE_CHAT`, `LIFE_MISHEARD`, `LIFE_PAST_*`,
  `LIFELOG_URL`) and the parked `TELEGRAM_*` and `INSTINCT_KEY`.
- Add the status Worker's new secret, `ISSUER` (`wrangler secret put ISSUER`, the connector's issuer), then redeploy it.
  The Worker works only with another issuer (his lifelog): with Life's own, it can't check a sign-in while the Mac is
  away, and a friend's install has no Worker.

## Release (his hand steps, once)

- A Developer ID Application certificate in his Keychain (Apple Developer account): `LIFE_SIGN_IDENTITY`, set
  for the release command (`.env` holds the Apple Development one his own builds use).
- `xcrun notarytool store-credentials <profile>` with an app-specific password: `LIFE_NOTARY_PROFILE`.
- Sparkle's key: `app/Frameworks/bin/generate_keys` (after one `bun scripts/app.ts`); the private half stays in his
  Keychain, the public one is `LIFE_SPARKLE_KEY`.
- A public repo for releases only (the source stays private): `LIFE_RELEASES_REPO`.
- Then each release: `LIFE_VERSION=x.y.z bun scripts/release.ts` with those set (and `LIFELOG_HOST_APP` once lifelog's
  host app exists).
