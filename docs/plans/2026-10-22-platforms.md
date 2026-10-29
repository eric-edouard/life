# Platforms and modules plan: Life (22 Oct 2026)

Note: Beeper was removed on 30 Oct 2026 ([no more Beeper](2026-10-29-no-beeper.md)); where this plan reads from Beeper, Life now reads through its own connectors.

The modules rework (phase 0, done), the move to Better-T-Stack (phase 1), and Windows, parked on 22 Oct ("scope out
Windows for now"): what exists for it and what a restart would need are at the end. Life only:
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
| Auth | Life's own OAuth issuer (`apps/server/src/host/http/oauth.ts`) |
| Add-ons | Biome with Ultracite; Turborepo with `apps/web`; the hand-written `.githooks` stay |
| Desktop | SwiftUI on the Mac (Life.app as it is). No Windows UI: a Windows Life, when it comes back, is a headless host |
| Actions | One actions backend per install, behind the outputs contract: Apple Reminders (remctl) or Google Tasks (`gog`) |
| Windows | Parked (22 Oct). The seams built for it stay (below) |
| Verification | No GitHub Actions (no build in CI). The pre-push hook's `bun run check` is the gate |
| Sessions | Phase 0 here; phase 1 in a session of its own, briefed from this doc. lifelog's phases have their own sessions and report |

The scaffold command, checked with `--dry-run`:

```sh
bun create better-t-stack@latest life --frontend none --backend hono --runtime bun --database none --orm none --api none --auth none --payments none --addons turborepo biome ultracite skills --examples none --db-setup none --web-deploy none --server-deploy none --no-git --package-manager bun --no-install
```

## Phase 0: the modules rework

Four kinds of module, one contract each. Today's code moves onto them before anything is ported, each move finished
in its PR: no second path left alive.

### Inputs

The contract exists: the source descriptor (`Descriptor`, `apps/server/src/sources/contract.ts`). Memory steps already branch on
`kind`, never on a name. What it needed:

- **The archive is a capability, not a second list** (done, #147). An archived source's descriptor carries its
  `store` (`app`, `copy`, `copies`, `media`), and each source copies its own store beside its reader; `ARCHIVED`,
  `keptStores` and the `missing` of archived sources derive from `SOURCES`.
- **Voice is a REST contract, not a second kind of reader.** The voice input is lifelog's REST API (below), and
  `apps/server/src/sources/lifelog.ts` is its one client. Another voice source would speak the same API rather than add a reader.
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
Reminders off it recorded an intent and emailed a failure. Now `OUTPUTS` (`apps/server/src/core/outputs.ts`) holds the outputs he can
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

Done (#153): `apps/server/src/core/platform.ts` holds every difference between macOS and Windows: `MACHINE` (Life's folder per computer,
`%LOCALAPPDATA%\Life` on Windows; it was `MAC`), `APP_DATA` (where Beeper keeps its store), Codex's binary for this
system and architecture, the model CLIs' environment, the system time zone (`Intl` on Windows) and the notification
(none on Windows). A source whose store exists only on the Mac (iMessage, WhatsApp's own app, Mail,
Notes) is `macOnly` and reads "macOS only" elsewhere. Left for a Windows restart (below): the plate's host
state (`mac.ts`: `launchctl`, `pmset`, `sysctl`, `df`), keeping store apps open (`archive.ts`: `ps`, `open`), the
Cloudflare tunnel's restart (`tunnel.ts`), the Contacts reader (`contacts.ts`: no address book on Windows), Tailscale's
binary (`tailscale.ts`: falls back to `tailscale` on PATH), the archive alert's log path (`report.ts`), remctl's path
(`remctl.ts`: Reminders is Mac-only; Windows acts through Google Tasks) and the checkout's LaunchAgents (`scripts/install.ts`).

### Secrets by place

The export leaves out "every file only its owner reads" by its Unix mode (`export.ts:34`). Windows has no such modes,
so an export there would carry the secrets. The secret files are named in one list (the sign-in's local key, the
agent's subscription, the OAuth issuer's state); `writeSecret` and `secretIn` write only those, and the export leaves
out exactly those.

### Verification

No GitHub Actions: the pre-push hook runs `bun run check` on the Mac. The check's Windows fixes (#151) came from a few
runs on GitHub's Windows runner before the workflow was removed.

**Done** (#147–#153, #155, #156, #151): the four contracts hold today's code with nothing left on the old paths, and
`bun run check` passes on the Mac.

## Phase 1: Better-T-Stack (done)

Routes on Hono: done (#158). Each route module (`oauth.ts`, `mcp.ts`, `check.ts`, `portrait.ts`, `dashboard.ts`) is a
Hono app; `server.ts` mounts them, one app per port, with `Bun.serve` only listening. Plain Hono for now: a route gains
`@hono/zod-openapi` when a client needs its contract (the web UI later), with its schema as the type's one source.

The connector's batched change: done (#159). The layout: done (#160). The scaffold command ran into a scratch folder,
and Life moved into its shape with `git mv`:

- `apps/server`: Life's TypeScript (`src/`: the memory core, the sources, the actions, the server's routes, the CLI and
  the helper's entry `cli.ts`), with its runtime dependencies. One package: the core is not split from the server,
  because nothing outside the server uses it (a web UI talks to the server over HTTP).
- `packages/config`: the shared TypeScript base (`tsconfig.base.json`), which the root `tsconfig.json` extends.
- The root: the Bun workspace (`apps/*`, `packages/*`, a catalog for versions shared with `scripts/`), `bts.jsonc` (so
  `create-better-t-stack add` works later), `bunfig.toml` (a hoisted install: Codex's binary at
  `node_modules/@openai/codex-<os>-<arch>`), and what is not the server's: `scripts/`, `prompts/`, `assets/`, `docs/`,
  `app/` (the Mac app), `worker/` (the edge), now `apps/mac` and `apps/edge` (#168). `ROOT` is still the repo root (or `LIFE_ROOT` in the app).
- Left out of the skeleton: its `varlock` (Life has its settings file and `.env`), `tsdown` (the helper is
  `bun build --compile`), its placeholder server entry, Turborepo (with one app it would run one task: it comes with the
  second app) and the Skills add-on (it generated nothing this repo uses). `bun run check` stays the gate. `scripts/`
  imports the server through its workspace package (`server/src/…`).
- **Rollout:** after the merge, `~/Work/life` needs `rm -rf node_modules && bun install` once (the old flat install has
  stale entries), then Life.app is rebuilt. The checkout's old LaunchAgent plists (`~/Library/LaunchAgents/
  com.ericedouard.life.*.plist`, not loaded: Life.app supervises the services) still name `src/cli.ts`; if a checkout
  ever runs the services again, `bun scripts/install.ts` writes them anew.

**What slots in later, without another restructure:** the web UI as `apps/web` (Vite, Tailwind), added with
`create-better-t-stack add`, talking to the server over HTTP (routes gain `@hono/zod-openapi` as it needs their
contracts) and bringing Turborepo; Better Auth in the server, behind the one sign-in seam (`ownerTokens` in
`auth.ts`, today fed by Life's own issuer); OpenRouter as a full model provider: it is already in
`PROVIDERS` (`llm.ts`) as the bench's runner, so it is one entry gaining its models per tier, plus `Engine` gaining
`openrouter`.

## Actions behind the outputs contract

The invariant "Life acts in one place: Apple Reminders" becomes "Life acts in one actions backend per install: Apple
Reminders (remctl) or Google Tasks (`gog`)". The ledger stays the truth (`actions.jsonl`, `openItems`); a backend is
only how a change is written and read back. One contract for both: list its lists, read the open and recently closed
items, add, edit, complete, reopen, delete and restore an item, and the board's list. What one backend lacks (Reminders'
sections and urgent flag, Google Tasks' none) the contract says by capability, never by the backend's name. The
`reminders` setting becomes the actions output's backend choice (done: `actions` in settings, `apps/server/src/actions/`). The
connector's tools keep their names; phase 1 (#159), in one batch (one reconnect), let `reminders`'s `target` take
a string id (`idOf`, `apps/server/src/actions/backend.ts`) and changed the descriptions from "Reminders" to "actions".

## Windows: parked

The owner scoped Windows out on 22 Oct, after deciding it would be a headless host only (no Windows UI: the WinUI 3 tray
of #154 was removed). What exists and stays, as clean seams:

- `apps/server/src/core/platform.ts`: `MACHINE` under `%LOCALAPPDATA%\Life`, `APP_DATA`, Codex's win32 binary, the model CLIs'
  environment, the time zone; `macOnly` sources (iMessage, Mail) never read there; WhatsApp and Notes read from an
  archive copied on a Mac, never copied there.
- The check's Windows fixes (#151): exports with `/` paths, every store in an archive on any system, ICU-proof dates.
- Google Tasks as an actions backend (#155); its string ids go through the connector since phase 1.

What a restart needs, as a headless host: services started by a setup script and Task Scheduler (or a Windows
service), secrets in Credential Manager or `.env`, setup and status through the CLI, the connector over Tailscale
Funnel; Gmail through `gog` as a mail input; Beeper (with WhatsApp through its bridge) and its archive; the helper
compiled for `bun-windows-x64`; the Mac-only spots listed under the platform module through `platform.ts`. Hand checks
on a Windows 11 PC (over SSH through Tailscale, key `~/.ssh/life_windows` on his Mac): `bun run check` there (four tests
ran past 5 s on GitHub's runner: brand's colour scan and three Notes tests), Beeper's
`%APPDATA%\BeeperTexts\index.db` read-only while Beeper runs, a headless night with zero sources, the connector
answering, Gmail signing in, Google Tasks' real JSON against the hand-written fixture. What cannot run there: iMessage,
Apple Notes and Mail (except an archive copied on a Mac), Apple Reminders, the Mac's Contacts.
