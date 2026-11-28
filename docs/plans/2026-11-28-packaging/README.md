# Packaging game plan (28 Nov 2026)

Goal: two pilots install Life on their own computer in early December, with no Terminal, no keys typed by hand where Life
can fetch them, and no step that does not apply to them. Later users follow the same path.

Live state: [tracker.md](tracker.md). Issues: label `packaging`.

## The pilots (what the plan is cut for)

| | Mac pilot | Windows pilot |
|---|---|---|
| Host | a Mac (specs unknown) | a Windows PC, no Mac |
| Phone | iPhone | iPhone |
| Ecosystem | Google first (Gmail, Google Calendar) | Google first |
| Pendant | Omi | Omi |
| Languages | English (German, Thai to ask) | English (Thai asked for) |
| Models | private open weights, about $15 a month | same |
| Allowed | Screen Time, Health, location; no Notes | same |

Promised: a packaged system "in a few days" (21 Nov) and a public, auditable repo (it is public).

## The owner's decisions

- 22 Oct: one download with auto-update; TestFlight; users pay their own ElevenLabs; a fresh install with zero sources runs a clean night.
- 25 Nov: one "Connect Google" step on Life's own OAuth client, tokens kept on the user's computer, consent screen "In production", unverified (#1377).
- 27 Nov: the phone reaches the host through OpenTunnel on Fly (`hostedbyme.app`); Tailscale only for users who have it ([private relay](../2026-11-27-private-relay.md)).
- 28 Nov: Lifelog Host folds into Life.app ([one Mac app](../2026-11-28-one-mac-app.md)).
- 28 Nov (this plan):
  - a Windows host;
  - onboarding is a setup window on the host, then a QR code hands off to the phone;
  - each user pays for their own model account;
  - the AI step offers Claude (their subscription, Claude Code detected or installed), OpenRouter, or both;
  - very aggressive batching: the fewest PRs;
  - the audit test: any agent auditing the public repo must answer that no data can leak;
  - pushes through the relay, ids only;
  - one GitHub Actions workflow for attested releases only;
  - Windows setup is a local page in the browser (loopback, local key), no Electron.

## The backbone: integrations

Every part a user can turn on is an **integration**: a source, a messaging network, Google, the AI, the voice engine,
the pendant, the way the phone reaches the host. Each has a name, an icon, a value line (one example ask), a privacy
line (what leaves, to whom), its requirements and its state. The setup window, the phone's onboarding and the menu
bar's dots read one list, so they are built in parallel once it lands. ("Connector" stays the name of Life's MCP server.)
Details: [spec.md](spec.md), section 1.

## The four parts

1. **Packaging.** Life runs with no source and nothing of the owner's; one download that updates itself; the iPhone app on TestFlight.
2. **Onboarding on the host.**
   1. The computer check: can it transcribe locally?
   2. Languages, then local voice or ElevenLabs, asked only when needed.
   3. The AI: Claude, OpenRouter or both.
   4. Sources, each with its value line and connect flow.
   5. A QR code to the phone.
3. **Onboarding on the phone.**
   1. Name.
   2. Permissions, each asked in context with its value line.
   3. Pendant pairing (Omi or Limitless).
   4. Messaging apps: tick the ones wanted, then the phone's sign-in sheet for each.
   5. Getting to know you: goals, what is going on, the people around.
   6. One real small task done (#1383).
4. **The host's own UI.** A native menu bar: one dot per integration, a red dot on the icon when one breaks; the current
   Settings and Status windows go (about −1,300 Swift lines). On Windows, the same in the tray.

## Facts that shape it

- Screen Time comes from the Mac's Biome store, which carries the iPhone's usage when "Share across devices" is on
  (`sources/screen.ts`). Apple's Family Controls cannot export usage, so no entitlement request. The Windows pilot
  gets no Screen Time.
- TestFlight internal is the only same-day path: each pilot becomes a user of the owner's App Store Connect team
  (no review). External TestFlight waits on a beta review (days).
- Google: Calendar, Contacts and Tasks are sensitive scopes (verification later); Gmail read is restricted (a CASA
  assessment before a public launch). Unverified works for up to 100 users, with one warning screen.
- ElevenLabs free tier: 4.5 h batch and 2.5 h realtime a month. Parakeet v3 runs on Apple Silicon, European languages
  only (no Thai).
- Omi is already supported by the iPhone app (`Capture`, `PendantProtocol`); Limitless is discontinued.
- Release tooling exists: `scripts/release.ts` signs, notarizes and writes the Sparkle appcast on GitHub Releases. No
  release has been published yet.

## Windows

- Already there: `core/platform.ts` paths and binaries; the voice server cross-compiles.
- The pilot's Windows memory is Google (bundle G), voice and the phone: Messages, Notes, Photos, Screen Time and the
  bridges are Mac-only or skipped (`healBridges` returns early on Windows).
- Voice on Windows starts with ElevenLabs Scribe; local speech (Parakeet fp32 ONNX on CPU, 8 GB floor, Python) comes later.
- Signing: Azure Artifact Signing takes individuals only in the US or Canada; ship unsigned to the pilot (one
  SmartScreen click) and bind the servers to 127.0.0.1 (no firewall prompt).

## Blockers found (from the inventory)

1. The phone reaches the host only through Tailscale today (`host/http/tailscale.ts`); the relay client is not built.
2. The iPhone app pushes with the owner's APNs key from the Mac (`apps/lifelog/apps/server/src/config.ts:172`): testers get no push.
3. No Gmail reader: mail is Apple Mail only (`sources/mail.ts:12`).
4. The engine defaults to `claude` (`core/settings.ts:184`); voice summaries need the Claude or Codex CLI.
5. git is a stub on a fresh Mac (#1515); bridges are built with `go` on the user's machine (`host/bridges.ts:332`).
6. Owner strings: `core/names.ts:53`, `desk/complaint-intake.ts:45`, `core/service.ts:28`, `core/settings.ts:141`;
   voice backups to a fixed iCloud path (`host/voice.ts:73`).
7. No onboarding on either device; no hardware check; the language cutoff is hardcoded to Thai (`route-turns.ts`).

## Bundles

One PR each. Strict paths keep the full workflow; the rest is fast mode. Scope and debt plans: [spec.md](spec.md), section 6.

| Bundle | What | Needs | Wave |
|---|---|---|---|
| **D. Distribution and bundling** | TestFlight script, git, gog and prebuilt bridges in the app, a tooling-proof release, the install page | – (now) | 1 |
| **R. Reach and push** (strict) | the relay client and pinned pairing; pushes through the relay, ids only (owner's yes); Tailscale as the fallback | – (now) | 1 |
| **A1. The integration read** (strict) | the shape, one health rule, `/status/integrations`, `read_integrations`, the duplicates deleted | #1561 | 1 |
| **A2. Core with nothing of the owner's** | engine chosen at `init`, the name at `init`, summaries through the chosen engine, backups to the user's cloud folder, language mode (#216), a clean zero-source night | A1; R for voice files | 1 |
| **G. Connect Google** (strict) | Life's OAuth client through gog, Gmail reader, Contacts, Calendar (#1377) | A1 | 1 |
| **T. Trust** | the audit test: privacy lines checked, README "Security and privacy", SECURITY.md, attested releases | A1 | 1 |
| **M. Mac app** | the setup window and the minimal menu bar | A1, one-Mac-app bundle 4 | 1 |
| **I. iPhone onboarding, day one** | permissions, pendant, messaging apps | A1, voice rename B2/B3 | 1 |
| **I2. Getting to know you** | the spoken interview and the first task (#1383) | I | 2 |
| **W. Windows host** | compiled Life and voice, a tray supervisor, Velopack, ElevenLabs voice | A1, A2, G | 2 |

Order: D and R start now; A1 next (it unblocks the rest); then A2, G, T, M and I side by side. The pilots' release is
cut after A2, G, M and a rehearsal on a fresh Mac account. W follows for the Windows pilot.

## How it is run

- This plan and the spec: Opus wrote them, one fresh Fable review reshaped them (spec.md's debt plan), then issues.
- One issue per bundle, label `packaging`, each naming what it needs; the tracker mirrors them.
- Fast mode for the rest; strict paths (`host/http/`, OAuth, the send paths, migrations) keep the full workflow.
- The tracker is updated at every move: a bundle started, a PR opened, a verdict, a merge.
- Before the pilots: a full rehearsal on a fresh macOS user account and on a Windows machine, as a pilot would do it.

## Open

- The Mac pilot's machine specs; both pilots' languages (asked by the setup window anyway).
- One pilot's ask to organise about 10,000 photos: outside packaging, kept for later.
