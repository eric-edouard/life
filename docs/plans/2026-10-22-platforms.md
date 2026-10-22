# Platforms plan: Windows, Android, Better-T-Stack (22 Oct 2026)

A scope, not a build: what a working Windows Life and an Android capture app take, the decisions taken on 22 Oct, and
the order to build in. Line numbers are from `main` at 3baf0e6 (Life) and lifelog's `claude/publish-prep` branch (which
holds the SQLite port and Lifelog Host). The long-form report, with the same tables, is
https://claude.ai/artifact/3abEKt6ftnbG59DiYgTTkc. Facts marked "verify" need a real Windows machine.

## Decisions (22 Oct)

| Question | Decision |
|---|---|
| Base | Better-T-Stack, set up with its CLI (`create-better-t-stack` 3.47.0) |
| Repos | Two repos, each re-scaffolded: Life (public) and lifelog (private) stay apart |
| Server | Hono on Bun in both. Life's `Bun.serve` routes move to Hono in the same change |
| API layer | None from Better-T-Stack: Hono with `@hono/zod-openapi`; the OpenAPI contract generates the Swift and Kotlin clients |
| Database | lifelog: SQLite with Drizzle. Life: none (its memory stays files and JSONL; `index.sqlite` stays raw `bun:sqlite`) |
| Auth | lifelog keeps Better Auth; Life keeps its own OAuth issuer (`src/oauth.ts`) |
| Add-ons | Turborepo, Biome with Ultracite, Skills. The hand-written `.githooks` stay |
| Phones | Native iOS (Swift) and native Android (Kotlin), for performance and battery; no Expo, no Tauri on the phone |
| Android MVP | Pair with the server by QR, drain an Omi over Bluetooth in a foreground service, upload, one status screen; new Life branding |
| Desktop | Native per OS: SwiftUI on the Mac (Life.app, Lifelog Host as they are), WinUI 3 tray on Windows. All logic stays in the Bun helper |

The scaffold commands, checked with `--dry-run`:

```sh
bun create better-t-stack@latest life --frontend none --backend hono --runtime bun --database none --orm none --api none --auth none --payments none --addons turborepo biome ultracite skills --examples none --db-setup none --web-deploy none --server-deploy none --no-git --package-manager bun --no-install
bun create better-t-stack@latest lifelog --frontend none --backend hono --runtime bun --database sqlite --orm drizzle --api none --auth better-auth --payments none --addons turborepo biome ultracite skills --examples none --db-setup none --web-deploy none --server-deploy none --no-git --package-manager bun --no-install
```

Better-T-Stack has no Swift or Kotlin frontends (its "native" ones are Expo), so `apps/ios`, `apps/android` and the
desktop shells sit in the workspace as plain folders beside the scaffolded TypeScript apps.

## What cannot be done on Windows

- **iMessage, live.** No Messages app; Phone Link has no history. An iPhone backup made by Apple Devices holds
  `sms.db` (same schema as `chat.db`), but only as fresh as the last backup.
- **Apple Notes and its versions.** iCloud for Windows has no Notes; Notes is web-only at iCloud.com, with no API.
- **Apple Reminders as the action surface.** No API off Apple devices. Another backend needs the invariant "Life acts
  in one place: Apple Reminders" changed first.
- **WhatsApp's own store.** The Windows app is a WebView2 wrapper with an encrypted, machine-bound database. WhatsApp
  comes through Beeper's bridge instead.
- **The Mac's Contacts.** No local address book on Windows.

## Life's macOS dependencies

Size in agent-days: S ≤ 1, M 2–4, L 5–10.

| Dependency | Where | On Windows | Lost | Size |
|---|---|---|---|---|
| iMessage `chat.db` | `sources/imessage.ts:10` | none; optional iPhone backups | live reading | M, optional |
| WhatsApp Mac store, archived | `sources/archived.ts:17`, `archive.ts:368` | WhatsApp through Beeper's bridge | `@lid` phones, media clones | S |
| Beeper `index.db` | `sources/archived.ts:21` | `%APPDATA%\BeeperTexts\index.db`, same SQLite (verify, and that it opens read-only while Beeper runs) | nothing | S + spike |
| Apple Notes | `sources/notes.ts:14`, `archive.ts:384` | none (OneNote through Graph would be a new source) | notes and their versions | L if OneNote |
| Apple Mail `.emlx` | `sources/mail.ts:10–11` | Thunderbird mbox (same MIME parser) or Gmail through `gog` | all-accounts coverage | M |
| Contacts | `sources/contacts.ts:11` | Google Contacts through `gog`, or none | names for bare handles | S–M |
| Git, imports, the agent's tasks | `sources/git.ts`, `assistants.ts`, `agent.ts` | as is | nothing | S |
| Reminders through `remctl` | `reminders/*.ts` | none; Microsoft To Do or Google Tasks as a second backend | sections, urgent flag | L if built |
| Past calendar | `memory/past.ts:274`, `LifeEventKit/main.swift` | `gog` as is; EventKit has no equivalent | Apple calendars | S |
| Notifications | `memory/report.ts:429` (`osascript`) | the shell posts them | nothing | S |
| `MAC` root | `truth.ts:40` | `%LOCALAPPDATA%\Life` | nothing | S |
| Keychain | `LifeApp/Helper.swift:130` | Credential Manager, read by the shell | nothing | S |
| Secrets known by mode 600 | `export.ts:34`, `secret.ts` | **Windows ignores modes: an export would include secrets.** Mark them by place | nothing once fixed | S |
| launchd | `scripts/install.ts`, `tunnel.ts:35`, `mac.ts` | the shell supervises, as Life.app does | nothing | S |
| Full Disk Access | `sources/index.ts:54–62` | not needed | a gain | – |
| Host state (`pmset`, `sysctl`, `df`, `launchctl`) | `mac.ts:31–103` | `Get-CimInstance`, `powercfg` | a coarser sleep log | M |
| Keeping apps open (`ps`, `open -g`) | `archive.ts:437–452` | `tasklist`, `Start-Process` | nothing | S |
| APFS clones | `archive.ts:119`, `export.ts:141` | full copies on NTFS | disk, staging time | S |
| `textutil`, `sips`, `pdftotext` | `memory/files.ts:114–126` | Poppler's `pdftotext`; HEIC needs a converter | HEIC descriptions | M |
| `/etc/localtime` | `memory/zones.ts:84` | `Intl` on both systems | nothing | S |
| Tailscale app path | `tailscale.ts:13` | `tailscale.exe`; Serve and Funnel from its CLI (verify) | nothing | S |
| cloudflared restart | `tunnel.ts:34` | a Windows service, or Tailscale only | nothing | S |
| restic to iCloud Drive | `backup.ts` | restic to a OneDrive folder | nothing | S |
| Codex binary path | `llm.ts:61` (darwin-arm64 only, also wrong on Intel Macs) | per-platform path; the pinned package ships win32 builds | nothing | S |
| Model CLI environment | `llm.ts:216` (Unix names only) | add `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`, `TEMP`, `PATHEXT` | nothing | S |
| Helper build | `scripts/helper.ts` | `--target=bun-windows-x64` | nothing | S |
| Signing, DMG, Sparkle | `scripts/app.ts`, `scripts/release.ts` | Authenticode; WinSparkle reads Sparkle's appcast and EdDSA signatures | nothing | M |
| The gate | `scripts/check.ts:36`, `scripts/scrub-check.ts:13` | `taskkill /T`; ship a word list | nothing | S |

The engines run natively: Claude Code on Windows 10 1809+ (x64, arm64), Codex in PowerShell.

## lifelog

The server (Bun, Hono, Drizzle, SQLite; ElevenLabs and OpenAI in the cloud) is already cross-platform. Mac-only:

- **The helper** (`apps/mac-quiet`, 687 lines plus 1,202 of QuietCore): dictation detection through Core Audio's
  per-process microphone flag (`main.swift:37–80`) becomes WASAPI session enumeration on Windows; model calls,
  keep-awake (`SetThreadExecutionState`) and the WebSocket move as they are.
- **Lifelog Host** (926 lines of SwiftUI): on Windows, part of the WinUI 3 tray.
- **The phone app** is iOS only (37k lines of Swift). The iPhone works against any server by URL; Android gets its own
  Kotlin app (below).

To keep one copy of the rules, QuietCore's dictation-range and model-call rules move into the Bun server first; each
platform's helper is then a thin sensor and runner.

## Phases

| # | Phase | Repo | Agent-days |
|---|---|---|---|
| 0 | Mac-side refactors and a Windows CI job | Life, lifelog | 5–7 |
| 1 | Re-scaffold both repos with Better-T-Stack | Life, lifelog | 6–10 |
| 2 | Android MVP | lifelog | 8–12 |
| 3 | Headless Windows Life | Life | 10–15 |
| 4 | WinUI 3 tray, signing, updates | Life, lifelog | 10–15 |
| 5 | lifelog's Windows helper and host | lifelog | 8–12 |
| 6 | Optional: actions backend, Contacts, iMessage backups, OneNote | Life | 5–10 each |

**0. Mac-side refactors.** Each its own PR, no Windows code, no bigger:
1. One platform module for every path and tool location (`MAC`, app stores, Tailscale, remctl, Codex), one table per OS.
2. A Mac-only source's `missing()` says "macOS only" on Windows; no new descriptor field.
3. Secrets by place, not by mode (`export.ts:34`).
4. Codex's path and the model environment per platform (`llm.ts:61`, `llm.ts:216`).
5. The shell posts notifications; `Intl` for the time zone.
6. One function per file-reading job in `files.ts`, with a per-OS command.
7. A GitHub Actions job running `bun test` on macOS and Windows.

Done when `bun run check` passes with net-zero or fewer lines and the Windows job runs.

**1. Re-scaffold.** Run the commands above into a fresh folder, then move each repo's code into the skeleton within the
repo (`git mv`, so history follows) and delete what the skeleton replaces. Life's server routes (connector, issuer,
`/check`, `/me`, status reads) move to Hono in the same PR; no route is left on `Bun.serve`. Done when each repo's
`bun run check` passes, the connector and lifelog's contract test answer as before, and nothing of the old layout is
left.

**2. Android MVP** (`apps/android` in lifelog; Kotlin, Jetpack Compose, Life's new branding): QR pairing (the same
`lifelog://pair` link), Omi over Bluetooth in a foreground service (the protocol from the iOS Kit's Omi codec), upload
with the device token through the OpenAPI client, one status screen. Nothing else. Done when an Omi paired to an
Android phone records a conversation that the server transcribes and Life reads.

**3. Headless Windows Life.** Beeper (with WhatsApp through its bridge), mail, git, imports, the agent; the archive for
Beeper; the nightly; the connector over Tailscale Funnel; Codex or Claude; restic to OneDrive; the Past calendar
through `gog`. Actions off. Set up by a script with Task Scheduler until phase 4. Done when a fresh install on Windows
11 runs a clean night with zero sources, a night with Beeper writes moments and pages, ChatGPT answers through the
connector, and a deleted Telegram message shows in `archive deleted`.

**4. WinUI 3 tray.** One Windows app for Life and lifelog's host duties, reading the helpers' JSON status as the Mac
apps do: H.NotifyIcon for the tray, app notifications, Credential Manager, unpackaged and self-contained first.
Authenticode (Azure Artifact Signing, under an organisation, or an OV certificate) and WinSparkle on the same appcast as
Sparkle. Done when a friend installs from one signed download with no terminal and the next release reaches them.

**5. lifelog on Windows.** The server's Windows build, the thin helper (WASAPI dictation detection, keep-awake, model
calls), host duties in the tray (tokens, QR pairing, Tailscale Serve, restic). Done when an iPhone or Android phone
paired to a Windows host gets transcripts, chapters and summaries.

Total for phases 0–5: about 47–71 agent-days.

## Open

- Mail on Windows: Thunderbird or Gmail through `gog`.
- Actions on Windows: off, Microsoft To Do or Google Tasks (needs the Reminders invariant changed).
- iMessage from iPhone backups for iPhone owners on Windows.
- The signer for Windows builds.
