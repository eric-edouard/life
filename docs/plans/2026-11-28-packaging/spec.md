# Packaging spec (28 Nov 2026)

The contract the bundles build on. Game plan: [README.md](README.md). Tracker: [tracker.md](tracker.md).

## 1. Integrations: one list of what a user can turn on

**What it is:** an integration is anything a user turns on that needs something from them to work: a source, a
messaging network, Google, the AI, the voice engine, the pendant, the way the phone reaches the host. **What it is not:**
the connector (Life's MCP server, which keeps that name), an output (`core/outputs.ts`) or an add-on (`core/add-ons.ts`),
which are settings with no step for the user. Glossary line in bundle A1; `connectors()` and `connectorHealths`
(`host/messaging-status.ts:38,154`) are renamed there, since they mean networks, not the connector.

### Shape

```ts
type Integration = {
  id: string;                    // "source:mail", "network:line", "google", "ai", "voice", "pendant", "reach"
  group: "ai" | "voice" | "sources" | "messaging" | "phone";
  name: string;                  // as the user says it: "WhatsApp", "Your Mac's photos"
  icon: string;                  // an asset name both apps ship (the app's real icon where there is one)
  value: { ask: string; answer: string };   // one example ask and the gist of Life's answer
  privacy: string;               // what leaves the computer, to whom, and how to turn it off ("Nothing leaves this Mac")
  requirements: Requirement[];   // what it takes, in the order the user meets it, each `done` when read
  state: "off" | "waiting_on_user" | "connecting" | "working" | "broken";
  why?: string;                  // plain words, for waiting_on_user and broken: what is wrong and what fixes it
};
type Requirement =
  | { kind: "permission"; check: AccessCheck }        // #1561's checks: full_disk_access, photos, contacts, calendars...
  | { kind: "sign_in"; with: "google" | "network" | "claude" }
  | { kind: "key"; name: string; opens: string }       // the page where the key is made
  | { kind: "credits"; with: "openrouter" }            // a balance above zero, read from the provider
  | { kind: "install"; what: "claude_code" }
  | { kind: "device"; what: "pendant" | "phone" };
```

Not `Need` (a card's need, `memory/needs.ts`) and not `needs_you` (a matter's state). Where it runs comes from
`macOnly` (`sources/contract.ts:145`), never a second field. Nothing of it is stored.

### One source of truth per fact

- The static part (name, icon, value line, privacy line, requirements) lives on the entry that already exists: a source's
  `Descriptor` (`sources/contract.ts:117`) gains one optional `integration` field; so do `NETWORKS` entries and
  `PROVIDERS`. No second table of sources.
- The state is decided once, by a pure `integrationHealthOf(facts)` in the shape of `agentHealthOf`
  (`host/agent-health.ts:73`): facts in, `{state, why}` out. Its facts: `missing()` and `newest()` through `toneOf`
  (`host/status/snapshot.ts:59`, which moves into it), the networks' health (`host/messaging-status.ts`), the access
  statuses (#1561), and a new engine check (the Claude CLI found and signed in; a key present; the OpenRouter
  balance; `isOnline`). `voiceStatus` (`host/voice.ts:491`) already decides voice: its result passes through, never
  judged again.
- `integrationsNow()` (`host/integrations.ts`) reads them once and returns the list. Its readers:
  - the status snapshot's source, bridge and voice cards, which stop deciding health themselves;
  - `GET /status/integrations` for the host app (local key);
  - the connector's `read_integrations` for the phone.
- Deleted as duplicates: the snapshot's own source and bridge judgment, `messaging-status.ts`'s second `readPart`, one
  of the two `polling` rules (`host/status/snapshot.ts:317`, `host/health.ts:24`). AGENTS.md's row "Whether a source is
  healthy" points at `integrationHealthOf`. CLI words ("run `bun life bridge link`") stay in the CLI; `why` is for people.

### Acting on a requirement: no new door

Each is met through the door it already has, so the trust rules stay where they are:

| Requirement | On the host (setup window, local) | On the phone |
|---|---|---|
| permission | the helper's `access ask` and the System Settings pane (#1561) | "I'm at my Mac" (#1561) |
| sign_in network | – | the sign-in sheet, `sign_in_to_network` |
| sign_in google | `gog` with Life's client, in the default browser | – |
| sign_in claude | the `claude` CLI's sign-in, in the browser | – |
| key | OpenRouter: its OAuth PKCE flow on a loopback port returns a key, with a spending `limit`; ElevenLabs: its key page opens, Life fills the key from the clipboard when the user copies it | – |
| credits | OpenRouter's credits page opens; the balance is re-read when the user comes back | – |
| install | Claude Code's official installer, run by the helper | – |
| device | the pairing QR | Bluetooth pairing in the app |

Keys are written by `writeSecret` (`secret.ts`), on both platforms; gog keeps its file keyring (`core/gog.ts:6-17`):
no Keychain item is added (a Keychain prompt blocks the app, AGENTS.md "Gotchas").

## 2. Setup on the host

A window that opens on first run and closes for good at the QR code. Each screen is skipped when its answer is
already known.

1. **Your computer.** Chip, memory, macOS version, free disk (`sysctl`, `ProcessInfo.physicalMemory`). Local speech
   needs Apple Silicon, macOS 14 and 16 GB; the result decides step 4 silently.
2. **You.** Name and email, read from the computer's account (macOS `id -F`) and confirmed in one field; `init` runs
   here (`host/init.ts:35-47` writes `truth/` with the name; `host/cli.ts:329` refuses to start without it).
3. **The AI.** Life looks for Claude Code and its sign-in.
   - **Claude:** "the most capable models, usually the best results; uses your Claude subscription". It is installed if missing, then signed in in the browser.
   - **OpenRouter:** "private open-weight models, about $15 a month, paid to OpenRouter". Its OAuth flow returns the key, then credits are bought.
   - **Both:** memory on OpenRouter, agents on Claude.

   Settings: Claude sets `engine: claude` and the claude runtime; OpenRouter sets `engine: openrouter` and pi; both sets `engine: openrouter` and the claude runtime.
4. **Your languages.** Tick the languages heard around you. The answer sets voice's language mode, which has three values:
   - **all local:** every language is within local speech's set, on a capable computer. Nothing more is asked.
   - **some to ElevenLabs:** today's fitted Thai routing (`route-turns.ts`), for languages outside the local set.
   - **all ElevenLabs:** no capable computer (Windows, Intel).

   ElevenLabs gets one screen with its key (section 1) and the real monthly cost for the user's case. The free tier
   (4.5 hours a month) covers only the occasional language, never a whole day's pendant.
5. **What Life looks at.** The integrations of group `sources`, each with its icon, value line and one Connect.
   Google first for a Google user ("Connect Google" covers mail, calendar, contacts, tasks). Apple sources appear only
   on a Mac. Several at once: tick, then Connect all.
6. **How far back.** For each source just connected, what it holds, counted with no model: "48,000 messages since
   2014". One choice for all: the last 3 months, the last year, or everything, each with its cost and time on the
   chosen AI (measured: about $1 per dense month of chats on OpenRouter; Claude: the subscription's usage). The user's
   pick is the approval of that import. It runs in the background from here on; setup never waits on it.
7. **Backups.** Life finds the cloud folders on the computer (iCloud Drive, Google Drive, OneDrive) and offers the
   first one: an encrypted restic copy goes there each night (`host/backup.ts`). The recovery key is shown once, to keep
   in a password manager. Neither the cloud provider nor the developer can read the copy.
8. **Your phone.** "Get the app": the TestFlight invite (sent by email; the screen shows what it looks like), then
   the pairing QR. The window closes when the phone pairs.

Messaging apps are not here: they are signed in from the phone, where the sheet already exists.

## 3. Onboarding on the phone

Starts at pairing. Each step can be left for later; a step left becomes an ask in the inbox, never a nag.

Day one (bundle I):
1. **Permissions in context.** One per screen, each with its value line before the system prompt: notifications,
   location ("Life knows where your day happened"), Bluetooth (the pendant), microphone (talking to Life), Health,
   photos. Screen Time is the Mac's (section 4).
2. **Your pendant.** Omi or Limitless (Limitless only for one already owned); pairing with live status; a first
   recorded sentence shown back, transcribed.
3. **Your messaging apps.** Tick the ones used; each then opens the sign-in sheet in turn, its state live from
   `read_integrations`. WhatsApp's line says it reads the Mac app (Mac only).

The first days (bundle I2, wave 2, kept):
4. **Getting to know you.** A spoken conversation with the main session: what is going on, the people around, the
   goals. It writes through its existing doors (`change_directory_entry`, `record_instruction`, goals in `truth/me.md`
   on the user's yes). Contacts from Google or the phone seed the people.
5. **One real small task** (#1383): the first thing Life does for the user, chosen from what step 4 said.

## 4. Facts that cut scope

- Screen Time: read from the Mac's Biome store, which carries a synced iPhone's apps with "Share across devices" and
  the same Apple ID, under Full Disk Access (`sources/screen.ts:103-105,161`). No Family Controls entitlement; none on Windows.
- Gmail read is a restricted Google scope: fine unverified for up to 100 users; a CASA assessment before a public launch.
- Telegram needs the user's own api keys (`sources/networks.ts:81`): last in the messaging list.
- `scripts/app.ts:31` builds for the build machine's chip only: an Intel Mac gets no local speech.

## 5. Trust: the audit test

The repo is public. Any user may ask their own agent: "Audit this project: will any of my data leak? Is it safe?" A
fresh agent's answer must be "safe" (the owner's rule of 28 Nov 2026). How:

- **Everything that leaves is named twice:** in SECURITY.md "What leaves the Mac" and at its code, as each
  integration's privacy line, both apps showing it beside the Connect button. A test fails when an integration has no
  privacy line, or when a host the code calls is missing from SECURITY.md's list.
- **The user can own every piece:** each third party is optional or replaceable (their own model account, their own
  Google client, their own relay, Tailscale, no relay at all).
- **What the developer hosts cannot read:** the relay passes encrypted connections it cannot open (TLS ends on the
  user's computer, its key pinned in the pairing code); pushes carry ids only. So nobody has to trust the running relay.
- **The app is the code:** releases are built from a tagged commit by GitHub's runners with an artifact attestation,
  checked with `gh attestation verify <file> --repo eric-edouard/life`; the app shows its commit. Anyone can also build
  it from source with one command. This needs one GitHub Actions workflow for releases only, with the signing secrets
  in GitHub: the owner's call (no CI today).
- **README "Security and privacy":** the audit prompt to copy, what stays on the computer, what leaves and why.
- **Before each release,** a fresh agent runs the audit prompt on the public repo; its answer is kept with the release.

## 6. Bundles

Sizes are changed lines. Strict paths keep the full workflow (plan review, confirming round); the rest is fast mode.
Each shared file has one owner bundle at a time, in this order: `host/voice.ts` and `apps/lifelog/apps/server`: R,
then A2; `scripts/app.ts`: D; `apps/mac`: the one-Mac-app bundles 3–4, then M.

### D. Distribution and bundling (starts now; ~+500)
- `scripts/testflight.ts`: archive, upload, add to the internal group with `asc`; the pilots become App Store Connect
  users with the least role.
- `scripts/app.ts`: git (#1515), a pinned gog and prebuilt bridges ship in the app (`host/bridges.ts:332` stops
  building with `go`); a universal build, or one per chip.
- A first release with `scripts/release.ts` as a check of the tooling (signed, notarized, appcast on GitHub Releases,
  an update from it to a second release). The pilots' release is cut after A2, G, M and the rehearsal.
- `docs/use/install.md`: the pilot's page.

### R. Reach and push (strict, hard: trust boundary; ~+900; starts now)
- The private relay plan's open milestones on the host and the phone (`docs/plans/2026-11-27-private-relay.md:118-120`).
- Pushes: the voice server sends to the relay, which holds the app's APNs key and forwards ids only. Waits on the
  owner's yes (SECURITY.md "What leaves the Mac"). The people digest's alert carries words today
  (`apps/lifelog/apps/server/src/apns.ts:244`): it becomes an id the phone resolves, like a card's.
- Fallback until R lands: Tailscale (`host/http/tailscale.ts`), with no push.

### A1. The integration read (strict: `host/http/`; ~+600 / −300; first, unblocks M, I, W)
- Section 1: shapes on the registries, `integrationHealthOf`, `integrationsNow`, `/status/integrations`,
  `read_integrations`, the deletes, the renames, the glossary and AGENTS.md lines. Needs #1561 merged.

### A2. Core with nothing of the owner's (fast; ~+700 / −300; needs A1, then R for voice files)
- The engine default no longer `claude` (`core/settings.ts:184`); `init` takes the name, email and engine (section 2).
- Voice summaries through the chosen engine instead of the Claude or Codex CLI on the Mac socket
  (`apps/lifelog/apps/mac-quiet/Sources/QuietCore/Summaries.swift:29-53` and its server side).
- Backups (section 2, step 6): voice's fixed iCloud path (`host/voice.ts:73-77`) and Life's `backup` setting become one
  choice, a restic repository in the cloud folder found on the computer (Windows: OneDrive or Google Drive).
- The language mode (#216), read by `route-turns.ts`.
- A zero-source night runs clean (a test).
- Kept on purpose: `DEVELOPER_CONTACT` (`core/names.ts:53`, the pilots' bug reports reach the developer) and the
  LaunchAgent labels (`core/service.ts:28`), per AGENTS.md "Nothing personal is committed".

### G. Connect Google (strict, hard: OAuth; ~+1,000; needs A1)
- Life's own OAuth client (desktop, PKCE, loopback) shipped in the app; `gog` runs with it (`gog auth credentials`,
  `--client`); `gogCall` (`core/gog.ts`) stays the one caller. Consent screen "In production", unverified.
- New: a Gmail reader source (`sources/gmail.ts` is send-only today), Google Contacts into
  `memory/contact-people.ts`'s input, Google Calendar read (#1377).

### H. History imports (~+900; needs A1, A2; Gmail's history with G)
Code does it all; no agent. An agent would only drive a wizard, and the one thing worth an agent, mending a parser on
the user's computer, is refused: an export holds other people's words, and letting them steer code that writes the
append-only memory breaks "Content never runs Life's code". Parsers are mended upstream instead (last bullet).
- **Counts.** One pure count per source beside its `earliest()` (iMessage `chat.db`, the archives' tables, Mail's
  Envelope Index, `readShown` in `sources/photos.ts:367`, which already counts, git `rev-list --count`, Gmail's
  `messagesTotal`), shown in the integration's value line. The export `--dry` readers already count.
- **The estimate.** Tokens per day of data from the count, times `core/prices.ts`; one function, shown in setup step 6.
- **Catch-up from a day.** One job runs what is now run by hand, in order, over the chosen range: `hear-voice-notes`,
  `historical-units`, then the model steps with their `--from` (episodes, extract, matters and the rest), the newest
  month first, resumable, drained over nights within the existing nightly caps. `backfillEngine` defaults to the
  chosen engine. Its progress is the source's integration line ("reading 2021, about 2 hours left"), so the phone
  and the menu bar show it with nothing new.
- **Zones.** A fresh install with no photos or sent mail seeds the computer's zone as the nearest known day
  (`memory/historical-zones.ts`).
- **One new parser:** a WhatsApp chat export (the `.txt` the phone shares per chat), the only chat history a Windows
  user can bring; kept as an import copy in `imports/whatsapp/` like the assistants' exports, so no new archive file.
  Instagram, ChatGPT and Claude exports already parse (`memory/imports.ts`); setup takes any of them dropped on its
  window.
- **Rules.** AGENTS.md and `docs/operations.md:160` gain one line each: for a new user, the pick in setup step 6 is
  the yes that "ask first" and "no scheduled backfill until prompts are frozen" call for, within its shown cost.
- **When a parser fails.** It throws a shape report: file names, keys and column names, counts, never a line's words.
  The caretaker offers it as its usual card, a mail draft to the developer sent only on the user's Send. The fix ships
  to everyone through the auto-update; the import resumes on the new version.

### T. Trust (~+400, mostly docs; needs A1 for the privacy lines)
- Section 5: the privacy-line test, README "Security and privacy", SECURITY.md completed, the release workflow with
  attestations (on the owner's yes), the pre-release audit run.

### M. Mac app (~+900 / −1,300; needs A1 and one-Mac-app bundle 4)
- The setup window (section 2), reading `/status/integrations`.
- The menu bar: one row per integration that is on, a dot each; the icon gets a red dot while any is broken; Open
  Life on your phone, Quit.
- Settings and Status windows deleted (`apps/mac`, about 1,300 of 1,862 lines). `VoiceSettings.swift`'s parts find
  homes first: speakers on the phone (voice cards already name them), backups automatic, Export, Import and Start
  fresh in a Voice submenu, the ElevenLabs key in the setup window.

### I. iPhone onboarding, day one (~+1,000; needs A1, voice rename B2/B3 landed)
- Section 3, steps 1–3.

### I2. Getting to know you and the first task (wave 2; ~+600; needs I)
- Section 3, steps 4–5.

### W. Windows host (wave 2; ~+1,200; needs A1, A2, G)
- `bun build --compile --target=bun-windows-x64` for Life and voice; MinGit, `gog.exe`, the embedder beside them.
- A Bun supervisor with a tray icon replaces launchd and the Swift app: starts the archive, the watcher, the night's
  tick and voice; its menu shows the integrations' dots.
- The setup (section 2) is a local page in the browser, on loopback only, behind the local key, reading
  `/status/integrations` (the owner's ruling of 28 Nov 2026; no Electron). The PR amends AGENTS.md's "Life serves no
  page" with this one exception. Windows needs no OS permissions: its steps are browser sign-ins, a key and a folder.
- Velopack install and updates from GitHub Releases, unsigned for the pilot; servers on 127.0.0.1.
- Voice all ElevenLabs; local speech and bridges later. The rehearsal checks that voice runs without Python.

## Debt plan
Tier: hard: a trust boundary (Google OAuth, the relay), strict paths (`host/http/`), a new concept (integration).
Inventory: sources `sources/contract.ts:117,145`, `memory/sources.ts:325,350,370`; health `host/status/snapshot.ts:59,317,481,540,1103`, `host/messaging-status.ts:38,73,154`, `host/health.ts:24`, `host/voice.ts:467,491`, `host/agent-health.ts:73`; networks `sources/networks.ts:45`; engines `models/llm.ts:82,499,544`; access in #1561. rg: `missing\(\)|connectorHealths|polling\(|voiceStatus|isOnline|toneOf`. Imports: `memory/imports.ts:61,249,340`, `memory/historical-collection.ts:34`, `host/command.ts:342,358`, `core/settings.ts:100`, `docs/operations.md:160`.
Shape: an integration's static facts on the registry entry that already exists; its state from one pure `integrationHealthOf`; one read, `integrationsNow`, served to both apps; acting through the doors that exist.
State: none new stored; keys through `writeSecret`; the setup window's progress is the integrations' state itself.
Deletes: duplicate health in the snapshot, messaging-status and the second `polling`; the Mac Settings and Status windows; `go` builds on the user's machine; Tailscale as default; the engine default; the fixed backup path.
Net lines: about +7,900 / −2,200 across the bundles (the phone onboarding and Windows are new surfaces).
Plan review: one fresh Fable review, reshaped: A split into A1 (the read), A2 (core) and G (Google); names `Requirement` and `waiting_on_user` (clashes with a card's need and a matter's state); the name asked at `init` on the host; #1561 and gog bundling as dependencies; tokens kept out of the Keychain; OpenRouter credits; the language mode with three values; shared files given owners; getting to know you and the first task moved to I2; R's fallback; the Windows setup screen put to the owner; the owner's contact and LaunchAgent labels kept.
