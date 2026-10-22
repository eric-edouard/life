# Architecture plan: one codebase, two hosts (22 Oct 2026)

Explanation and plan: the code and repo shape Life needs before the [server plan](2026-10-22-server.md) adds a web UI,
a messaging layer and a second host. Measured on `main` at ebcb851; each step below names its PR. Done: all seven steps merged (#162–#168).

## Where the code is today

`apps/server/src` is 25,000 lines in one package: 45 files at the top, plus `memory/`, `sources/` and `actions/`.
The contracts from the modules rework hold (sources, outputs, providers, the actions backend, the platform), but the
folders do not say what depends on what, and nothing stops a file reaching across:

- **Ten import cycles**: the actions backend with its backends (`act` ↔ `backend` ↔ `remctl`, `google`), and the
  source registry with its readers (`sources/index` ↔ `agent`, `archived`, `assistants`, `git`, `imessage`, `mail`).
- **The memory reaches up into the host**: `memory/nightly` imports the archive, the backup, events, tasks and the
  actions backend; `memory/history` imports the archive; `memory/search` imports events and tasks.
- **The top folder mixes four jobs**: foundations (`clock`, `proc`, `lock`, `log`, `secret`, `settings`, `platform`),
  HTTP (`server`, `oauth`, `mcp`, `check`, `portrait`, `dashboard`), Mac host code (`mac`, `plate`, `tailscale`,
  `tunnel`, `archive`) and jobs (`watch`, `tasks`, `events`, `cli`).
- **One schema file** (`schema.ts`, 783 lines, 80 exports) holds every record of every module.
- `clock` imports `truth` (for the root folder), so the lowest layer depends on a higher one.

None of this is broken. It is what makes the next 20,000 lines expensive: a second host, a messaging layer and a web UI
would each add their branches into these same files.

## The rule

Dependencies point one way, and `bun run check` enforces it with fallow's boundary zones (fallow already runs in the
check; zones are one config key, `boundaries` in `.fallowrc.json`), so the shape cannot erode, whichever agent writes the code:

```
core  ←  records  ←  models, sources, messaging, actions  ←  memory  ←  host (jobs, routes, CLI)  ←  apps
```

- **core**: clock, paths and the platform, settings, process, lock, log, secrets, redaction, and Life's fixed names
  the settings validate (`core/names.ts`: the engines, the sources, the agent's word): adding a source names it there.
- **records**: every record Life writes, as zod schemas (`records/`, mirroring `docs/SCHEMA.md`).
- **Capabilities**, each one contract plus its implementations, none importing another:
  - `models`: `PROVIDERS`, the call, the cache.
  - `sources`: the input descriptor and its readers; the Mac's stores (iMessage, Mail, Notes, Contacts, the WhatsApp
    and Beeper stores) under `sources/mac/`, the network ones (lifelog, git, IMAP, CardDAV) beside them.
  - `messaging`: the messaging contract (list chats, read since a cursor, save on arrival, send with the owner's
    yes) and its one backend, Matrix. Each enabled network gives a source descriptor, so the memory sees one more
    input and never the word "WhatsApp".
  - `actions`: the actions contract and its backends (Reminders, Google Tasks).
- **memory**: units, moments, observations, pages, the ledger, search, statements. It reads capabilities through
  their contracts and never schedules, serves or sends anything.
- **host**: what runs: the jobs (nightly, watch, archive, backup), the HTTP routes (connector, issuer, pages, the web
  UI's API), the CLI. It composes the capabilities into a running Life. This is the only layer that knows which host
  it is on.
- **apps**: entry points only.

The two hosts are not two code paths. A host is a set of capabilities, read once like the settings: which sources
exist, which model engines, how services are supervised (Life.app or Compose), how the connector is reached (Tailscale
or a reverse proxy), how the archive is fed (copying stores or saving on arrival). Code asks for a capability, never
"am I the Mac", the rule sources already follow.

## The repo

```
apps/
  server/      the host layer and its entry (CLI, jobs, routes): what Life.app compiles and the container runs
  web/         the web UI (Vite, Tailwind): onboarding, settings, status
  mac/         Life.app, two modes: full local Life, or companion to a server
  edge/        the edge Worker
packages/
  api/         the HTTP contract (zod schemas) the server serves and the web UI calls: types from one source
  brand/       assets/brand/tokens.css and what the web UI, the email and the app copy from it
  config/      the TypeScript base
deploy/        compose.yaml, the DigitalOcean cloud-init, Coolify's notes
prompts/ scripts/ docs/
```

Inside `apps/server/src`, the layers are folders, and each folder is a fallow zone: `core/`, `records/`, `models/`,
`sources/`, `messaging/`, `actions/`, `memory/`, `host/`. `schema.ts` becomes `records/`, split by the parts of
`docs/SCHEMA.md`.

**Why folders and not a package per layer.** A package earns its cost (its own `package.json`, tsconfig, build
config and import name across 150 files) when a second app imports it. Today only `api` and `brand` have two
consumers (the server and the web UI; the email, the app and the web UI). The layers have one consumer, the server, so
zones give the same enforced boundary for less. A zone becomes a package the day a second app needs it: a mechanical
move, because the boundary already holds. Turborepo arrives with `apps/web`, as the platforms plan said, and runs each
app's check and build.

## The order

Each step is one PR that changes no behaviour, passes `bun run check`, and leaves no old path alive:

1. **Zones and the rule** (#162). Fallow's boundary zones over today's folders (`boundaries` in `.fallowrc.json`), plus a
   `records` zone (`schema.ts`, `truth.ts`) that core may not import, so steps 2 and 5 show. `outputs.ts`
   counts as core: it reads only the settings. Today's 61 violations (29 outside tests) sit in a baseline,
   `.fallow-baseline.json`, which the check reads: a new violation fails from the first PR, and each step below re-saves
   a smaller one (`scripts/baseline-check.ts` refuses a baseline that grows).
2. **core** (#163). The foundations into `core/`; `clock` stops importing `truth` (the root folder moves to `core/paths`), and
   `truth.ts` joins the memory.
3. **The cycles** (#164). Each capability's contract in its own `contract.ts` (the source descriptor; the actions
   backend and `Change`): implementations import the contract, the registry (`sources/index.ts`, `actions/backend.ts`)
   imports the implementations, so nothing imports back. The ten cycles go.
4. **The memory stops reaching up** (#165). The host's files move into `host/` (`http/`: the routes and the connector;
   `status/`: the plate and Life's status; the jobs, the CLI and the outputs flat), with the nightly, the memory
   command, the report, `act` and `inbound` among them. `history.ts` keeps memory's run history and Life's status
   moves to `host/status/life.ts`; the agent's tasks as the ledger holds them (wake words, `Update`, `standing`) move
   to `memory/tasks.ts`, `host/tasks.ts` keeping the writes and chases; `isReviewCall` joins `core/log`, `actionLine`
   `actions/items.ts`; `llm.ts` is `models/llm.ts`. The memory imports nothing above it.
5. **The records** (#166). `schema.ts` becomes `records/`, one file per part of `docs/SCHEMA.md` (truth, ledger, sources,
   units, moments, observations, statements, and the field shapes they share). The records stay a layer of their
   own rather than moving into their users: the sources read records the memory also uses (people, projects, units,
   the ledger), so moving them into the memory would point the sources up. Every layer but core may import them. The
   names the settings validate (`Engine`, `Runner`, `SourceName`, `AGENT_WORD`) go to `core/names.ts`, so core imports
   nothing above it.
6. **No baseline** (#167). The source registry moves into the memory (`memory/sources.ts`), with the agent's source,
   which reads Life's own ledger; `digest` to `core/hash.ts`; `CLOSED_ON_SILENCE_S` to lifelog's reader; the tests
   that ran a reader through memory move to the memory's tests. No violation is left, and `.fallow-baseline.json`
   and its check go. `docs/architecture.md` ("The code") has the rule and the map.
7. **The repo** (#168). `app/` → `apps/mac`, `worker/` → `apps/edge`, each a workspace package. `packages/brand`
   waits for its second consumer: it comes with `apps/web`, `packages/api` and Turborepo, through
   `create-better-t-stack add`, as the first PR of the server plan.

Then the server plan's phases build on it: messaging lands in its own zone, the server host as a capability set,
and nothing in the memory changes for either.

`docs/architecture.md` has the rule and the map since step 6; AGENTS.md has carried the rule since step 1.

## Decided (22 Oct)

| Question | Decision |
|---|---|
| Layers | Folders as fallow zones inside `apps/server`; a package only for a second consumer |
| Order | All seven steps before any server feature |
| Sessions | One session, steps 1–6 in order; step 7 may run in parallel |
