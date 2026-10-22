# Platforms and modules plan: Life (22 Oct 2026)

What it takes for Life to run on Windows and on Better-T-Stack, and the modules rework that comes first. Life only:
lifelog is one of Life's inputs and has its own report (its phone apps, the Android MVP, its desktop host, and
transcription). Line numbers are from `main` at 3baf0e6. The long-form scope report is
https://claude.ai/artifact/3abEKt6ftnbG59DiYgTTkc. Facts marked "verify" need a real Windows 11 machine.

## Decisions

| Question | Decision |
|---|---|
| Base | Better-T-Stack, set up with its CLI (`create-better-t-stack` 3.47.0); Life and lifelog stay two repos |
| Server | Hono on Bun; every route moves off `Bun.serve` |
| API layer | None from Better-T-Stack: Hono with `@hono/zod-openapi` |
| Database | None: the memory stays files and JSONL in its git repo; `index.sqlite` stays raw `bun:sqlite` |
| Auth | Life's own OAuth issuer (`src/oauth.ts`) |
| Add-ons | Turborepo, Biome with Ultracite, Skills; the hand-written `.githooks` stay |
| Desktop | SwiftUI on the Mac (Life.app as it is); a WinUI 3 tray on Windows, which lifelog's host joins. All logic stays in the helper |
| Mail on Windows | Gmail through `gog` |
| Actions | One actions backend per install, behind the outputs contract: Apple Reminders (remctl) or Google Tasks (`gog`); Windows uses Google Tasks |
| iMessage from iPhone backups | Not now |
| Windows signing | Unsigned builds first; the signing step is wired so an Authenticode certificate drops in |
| Verification | GitHub Actions' Windows runner (build, tests, a headless night with zero sources, the connector answering), then the owner's Windows 11 PC over SSH through Tailscale (key `~/.ssh/life_windows` on his Mac) |
| Sessions | Phase 0 here; the re-scaffold, headless Windows and the WinUI 3 tray each in a session of its own, briefed from this doc. lifelog's phases have their own sessions and report |

The scaffold command, checked with `--dry-run`:

```sh
bun create better-t-stack@latest life --frontend none --backend hono --runtime bun --database none --orm none --api none --auth none --payments none --addons turborepo biome ultracite skills --examples none --db-setup none --web-deploy none --server-deploy none --no-git --package-manager bun --no-install
```

## Phase 0: the modules rework

Four kinds of module, one contract each. Today's code moves onto them before anything is ported, each move finished
in its PR: no second path left alive.

### Inputs

The contract exists: the source descriptor (`Descriptor`, `src/sources/index.ts:67`). Memory steps already branch on
`kind`, never on a name. What it needed:

- **The archive is a capability, not a second list** (done, #147). An archived source's descriptor carries its
  `store` (`app`, `copy`, `copies`, `media`), and each source copies its own store beside its reader; `ARCHIVED`,
  `keptStores` and the `missing` of archived sources derive from `SOURCES`.
- **Voice is a REST contract, not a second kind of reader.** The voice input is lifelog's REST API (below), and
  `src/sources/lifelog.ts` is its one client. Another voice source would speak the same API rather than add a reader.
  Its units keep the source name `lifelog`: unit ids are stored in memory, and renaming them needs a map.
- **The platform says what it lacks.** A source whose store does not exist on this OS reports it through `missing()`
  (the platform module below), so `init`, the plate and `readySources` need nothing new.

**What Life expects from a voice input** (lifelog today, any voice source tomorrow), over its REST API:

- a change feed of chapters: id, time span, title, summary, and turn refs (speaker, start, end), summary empty until
  done (`/changes`);
- a transcript per job, turns with speaker and words, fetched on demand (`/transcription-jobs/{id}/transcript`);
- exact-word search over transcripts (`POST /search`);
- the owner's corrections written back: speaker, title, rename, merge (`forward`, the only write);
- optional: where he was (`/where`, `/visits`) and the source's own status (`/status`).

Life never receives audio and keeps no transcript text (except an ask's words). This list is lifelog's input contract
with Life; lifelog's report owns how it is met.

### Outputs

Done (#148). Each output had its own switch and shape, and `act` did not check the Reminders switch itself, so with
Reminders off it recorded an intent and emailed a failure. Now `OUTPUTS` (`src/outputs.ts`) holds the outputs he can
turn on or off (Reminders, the Past calendar, the connector, the backup), each with its label and its switch: `isOn`
asks it, `off` says why one does nothing, the plate's cards take their names and "off" from it, and `act` refuses
before recording. Each output's own module does the work and reads the rest of its settings. The report is not a
switch: it always goes, by email with a `mail` setting, else as a local page. The agent's asks follow `agent`; the
voice corrections follow the voice input.

### Model providers

Done (#149). `PROVIDERS` in `llm.ts` has one entry per provider: `claude` and `codex` (his subscriptions' CLIs),
`anthropic` and `openai` (API keys), `openrouter` (the bench only). Each holds its models by tier (`fast`, `main`,
`deep`; OpenRouter's come from `LIFE_LLM`), its effort, its call, whether it may run tools, and its quota when it has
one. `llmFor`, the tools rule and the quota read it. Still to move, to the platform module: Codex's binary path
and home, and the CLIs' environment.

### Transcription providers

Transcription belongs to lifelog, not Life: lifelog holds the audio and Life never sees it (an invariant: memory does
not move into lifelog, and audio does not move into Life). The contract lives in lifelog's report. From the Transcription
v2 benchmark (interim, 22 Oct), the shape a provider must give: timed words, each with a speaker label (nullable) and an
optional confidence; a language per job, better per turn. Diarization can be a separate stage (pyannote) merged onto
the words. The likely winner routes by language (local models for English and French, Scribe or a Thai model for
Thai), and the same audio is never transcribed twice. Life depends only on the voice input above, whatever produces it.

### The platform module

Every OS difference in one module, one table per OS, so Windows is a second table and not a branch in nine files:

- paths: the `MAC` root (`truth.ts:40`, `%LOCALAPPDATA%\Life` on Windows), the app stores (`whatsapp.ts`, `beeper.ts`,
  `notes.ts:14`, `mail.ts:10`, `contacts.ts:11`, `imessage.ts:10`);
- tools: Tailscale (`tailscale.ts:13`), remctl (`remctl.ts:13`), Codex's binary (`llm.ts:61`, darwin-arm64 only today,
  also wrong on Intel Macs);
- the model CLIs' environment (`llm.ts:216`: Windows needs `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`,
  `TEMP`, `PATHEXT`);
- the host's state for the plate (`mac.ts`: `launchctl`, `pmset`, `sysctl`, `df`), keeping store apps open
  (`archive.ts:437`), the notification (`report.ts:429`), the time zone (`zones.ts:84`, `Intl` on both).

### Secrets by place

The export leaves out "every file only its owner reads" by its Unix mode (`export.ts:34`). Windows has no such modes,
so an export there would carry the secrets. The secret files are named in one list (the sign-in's local key, the
agent's subscription, the OAuth issuer's state); `writeSecret` and `secretIn` write only those, and the export leaves
out exactly those.

### CI

A GitHub Actions job runs `bun run check`'s tests on macOS and Windows. Until it exists, nothing in this plan is
verified off the Mac.

**Done when** the four contracts hold today's code with nothing left on the old paths, `bun run check` passes on the
Mac, the Windows job runs, and the change is net zero or fewer lines.

## Phase 1: Better-T-Stack

Run the scaffold command into a fresh folder, then move Life into its skeleton within the repo (`git mv`, so history
follows), and delete what the skeleton replaces. Every route moves to Hono in the same PR: the connector and its OAuth
issuer, `/check`, `/me`, the status reads. **Done when** `bun run check` passes, the connector, `/check` and the
status reads answer as before, Life.app builds and runs from the new layout, and no route is left on `Bun.serve`.

## Phase 3: headless Windows Life

What runs on Windows: Beeper (with WhatsApp through its bridge) and its archive, Gmail through `gog` (a new mail input),
git, imported assistant chats, the agent's tasks; the nightly; the connector over Tailscale Funnel; Codex or Claude;
restic to a OneDrive folder; the Past calendar through `gog`. Actions off. Set up by a script with Task Scheduler until
the tray exists. What cannot run there: iMessage, Apple Notes, Apple Mail, Apple Reminders, the Mac's Contacts.

**Done when**, on the Windows runner: the helper compiles for `bun-windows-x64`, the tests pass, a headless night with
zero sources ends clean, and the connector answers a sign-in-free probe. **Hand checks on a Windows 11 machine:**
Beeper's `index.db` at `%APPDATA%\BeeperTexts` opens read-only while Beeper runs; a night with Beeper writes moments;
Tailscale Funnel serves the connector; Gmail through `gog` signs in.

## Phase 4: the WinUI 3 tray

A Windows tray app reading the helper's JSON status and editing settings through it, as Life.app does: H.NotifyIcon,
app notifications, Credential Manager, unpackaged and self-contained. Built so lifelog's host joins it (its own
section, its own helper), coordinated with lifelog's session. WinSparkle reads the same appcast as Sparkle. The signing
step takes an Authenticode certificate when there is one. **Done when** the CI builds the tray; a hand check on
Windows 11 installs it, sees the status and survives a restart.

## Actions behind the outputs contract

The invariant "Life acts in one place: Apple Reminders" becomes "Life acts in one actions backend per install: Apple
Reminders (remctl) or Google Tasks (`gog`)". The ledger stays the truth (`actions.jsonl`, `openItems`); a backend is
only how a change is written and read back. One contract for both: list its lists, read the open and recently closed
items, add, edit, complete, reopen, delete and restore an item, and the board's list. What one backend lacks (Reminders'
sections and urgent flag, Google Tasks' none) the contract says by capability, never by the backend's name. The
`reminders` setting becomes the actions output's backend choice; the connector's tools keep their names and arguments
(a reconnect is costly), their descriptions say "actions" where they say "Reminders".

## lifelog's host in the tray

lifelog's server serves `GET /status/live` on loopback (127.0.0.1:47613), owner-only, with the device token; its JSON is
typed in lifelog's openapi.json (sample `fixtures/wire/status-live.json`), and its verdict rules stay on the server, so
the tray only renders. The tray's lifelog section reads it as the Mac's Lifelog Host does; Life's section reads Life's
own status reads (`/status/snapshot`, `/status/card/<id>`, `/status/run` on `LOCAL_PORT` 46201 behind the local key).

## Hand steps left to the owner

- His Windows 11 PC reachable over SSH through Tailscale (in progress), for the hand checks above.
- An Authenticode certificate, when Life goes to friends on Windows.
