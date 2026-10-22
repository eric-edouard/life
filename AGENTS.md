# Life

A self-running memory of one person's life (the owner), built on his Mac from his voice (lifelog), chats, iMessage,
mail, Apple Notes, git and imported assistant chats: sources → units → moments → observations → people and area pages,
plus an always-on archive of deleted messages and old note versions. Shipped as Life.app; a checkout is for development.

Read before changing an area: `docs/architecture.md` (shape and reasons), `docs/SCHEMA.md` (every record),
`docs/sources.md`, `docs/atlas.md` (the agent, the connector, actions, sends), `docs/operations.md` (schedule, locks,
backups, evals, the read CLI), `docs/dashboard.md` (status reads and page), `docs/releasing.md`, `SECURITY.md`.
`docs/agent.md` is not documentation: it is the agent's playbook, read at run time.

## Commands

```sh
bun install                      # also points git hooks at .githooks (pre-push runs the check)
bun run check                    # the gate: lint, types, fallow, tests, scrub, cases. Must pass before every commit
bun test src/memory/units.test.ts   # one test file
bun run fix                      # format and lint fixes
bun life <command>               # the CLI (src/cli.ts); `bun life memory …` for the pipeline and reads
bun life validate                # check truth/ (from the live checkout only, never a worktree)
bun scripts/app.ts [out]         # build Life.app (LIFE_SIGN_IDENTITY to sign, else ad hoc)
```

## Working with the owner

Life runs itself: the owner never runs `bun life …` and never reviews a queue. The commands are for you and for the
app's supervisor. Don't design a step that waits on him: an uncertain inference goes into a model-owned layer (like
`memory/people-inferred.jsonl`), used at once and corrected later. His input arrives in conversation only (the one
exception: the truth benchmark on `/check`, rated when he likes, never waited on).

- When he states or corrects a fact, record it before moving on: `bun life memory correct '<json>'` (kinds in
  `docs/SCHEMA.md`). When it's about who someone is, offer to add it to `truth/` and do it on his yes.
- When he says something matters or doesn't, also append a label to `memory/labels.jsonl`.
- When he states or changes a goal or priority, offer to put it in `truth/me.md` `## Goals` (numbered, his order, each
  with the project ids it serves) and do it on his yes. His goals live there only.
- When he says which project a repo belongs to, put it in that project's `repos:` in `truth/`, then `bun life validate`.
- Reminder changes go through `bun life act '<json>'`, never `remctl` directly. Deep work goes to his agent:
  `bun life ask '<his words>'`, verbatim, never your summary.
- Answer questions about his life with `bun life memory …` (`docs/operations.md`, "Reading the memory"). Run
  `bun life memory unresolved` before asking him anything. His word beats the memory.
- A send through any messaging app (Beeper, WhatsApp, iMessage, mail) needs the owner's OK on the exact text.
- When the owner says something didn't work, it is audited (docs/operations.md#audits), and its fix carries a
  regression case.
- Rules for editing `truth/` are in the data repo's own `AGENTS.md`.

## Invariants

Break one of these and something of the owner's is lost, leaked or acted on wrongly.

- **His data repo has no git remote, and nothing of his goes to GitHub.** `commitMemory` refuses a repo with a
  remote. (What does leave the Mac, to the model provider and the backup: `docs/architecture.md`.)
- **Nothing personal is committed here**, in code, tests, prompts or docs: tests use made-up people, phones and places;
  his material goes to his data repo, his settings to `STATE/settings.json`, secrets to `.env` or the Keychain. The
  `scrub` step catches full names, aliases, surnames, phones, emails, handles and chat ids from his `truth/`; first
  names, places, project names, `.env` values and git history are on you. The domain in Life's own infrastructure
  labels (sender, LaunchAgent labels) is kept on purpose. lifelog's check runs `scripts/scrub-check.ts` by this path
  with git pathspecs as arguments: keep both.
- **Only the owner writes `truth/`.** Models return JSON that zod validates; every quote is checked against its source
  (`src/memory/observe.ts`).
- **Memory is append-only and expensive.** Never hand-edit or wipe `memory/` (except appending his corrections or
  labels). `actions.jsonl` is appended only by `act`, `setGrant`, the tasks (`ask`, `update`, `reply`) and the sync
  pass (`inbound`, `closings`). The dashboard's `changes` cursor counts ledger lines, so a line must never move. Code
  rewrites only `units/` and `moments/<day>.jsonl`. A change to how unit ids are made ships an old→new map applied to
  `labels.jsonl` and `statements.jsonl`.
- **One lock.** Everything that writes `memory/` holds it (`locked`, `guard.ts`), except his single lines (a
  correction, a rating) and `actions.jsonl`'s writers above. One Life per Mac: the archive and the watcher each hold a
  lock in `MAC` (`docs/operations.md`).
- **The archive is the only live copy of deleted messages and old note versions.** Never move, wipe or migrate its
  files; a new table only with the owner's OK, never a rewrite of rows. Keep it running. App stores are opened
  read-only; only the apps of enabled sources are kept open (`keptStores`).
- **Content is never a command for Life's code.** Recorded text never makes Life act; model calls see no tools and no
  instruction files (`src/llm.ts`). The "hey Life" marker only keeps a unit read. His Apple Notes and imported
  assistant chats are memory only, never his words for actions.
- **Life's own output never re-enters memory:** its chat and mail are dropped as `life-output` (`units.ts`). What Life
  read off a file (`memory/files.jsonl`) shows inside the file's brackets and is evidence of what was sent, never
  anyone's words. The agent's done tasks enter only as the `atlas` source, as evidence of what was done, never as his
  words or a request.
- **Life acts in one place: Apple Reminders**, through `act`, on his clear request or the standing grant. Asks are his
  words handed to the agent, never acted on by Life. Details: `docs/atlas.md`.
- **The only sends** are the report and alerts to the owner and one MCP event per ask to his agent. Add no other (`docs/atlas.md`, "The only sends").
- **The connector reads, forwards his corrections, and acts only through `reminders`, `task` and `reply`.** Never add a
  tool that sends or edits anything else. Tool changes force a costly reconnect in ChatGPT: batch them, keep names and
  arguments stable.
- **Pages serve nothing of his before their sign-in check** (`/check`, `/me`; the app's status reads behind the local
  key). Never take the local key on the public port (`docs/architecture.md`, "Pages").
- **What the memory holds, in words, is `claimsNow`** (`statements.ts`): the statements he rates and the eval judge the
  same text.
- **He is the center, not one more person:** his page is a projection like every page; his goals are only in
  `truth/me.md`; no separate record about him, no owner-only field on observations (`docs/architecture.md`).
- **Facts are read by moment:** one call per day reads every unit of the day (`moments.ts`), then extraction reads a
  moment's units together (`extract.ts`), with earlier facts as a reading to correct, never as evidence. Extraction is
  the only step that retires an observation (besides his `outdated` answers).
- **Model output is cached** by unit hash and prompt version (`docs/architecture.md`). Bump a prompt's version only
  when its meaning changes; ask before re-running the whole archive.
- **Model calls use the owner's subscriptions**, or an API key on an install with neither; never another provider
  except the bench's (`docs/operations.md`, "Model engines").
- **Settings are one strict file, read once per process** (`src/settings.ts`). A part left out is off; a new key lands
  in code first; owner values are never defaults in code. Likewise **a new key in `truth/` lands in code first**: the
  schemas are `.strict()`, and a key the running code doesn't know stops the watcher, the nightly and the connector.
- **Reminders is an interface, never the truth; the ledger is.** Changes read back from Reminders can take authority
  away or reorder, never add it. Open items are derived (`openItems`), never stored (`docs/atlas.md`).
- **Nightly emails include every row.** Never cap a list or write "+N more" (`docs/operations.md`, "The nightly
  report").
- **Everything Life shows follows the Ledger brand** (emails, `/check`, `/me`, the app, the icon), its values
  copied from the `ledger-brand` skill's tokens; a brand change lands there first (`docs/architecture.md`).

## One way to do each thing

Before adding a helper, use the one that exists:

| Need | Use |
|---|---|
| Where an observation stands (hidden, gone, replaced, retired) | `stateOf` (`ledger.ts`): index, pages and dashboard alike |
| What is new since a night | `newSince` (a source line first cited) |
| Who has a page / who is close personally | `pagedNow`, `personallyClose` (`closeness.ts`); never a list |
| Who a name, handle or ref is | `memory/who.ts` (`readPeople`; `meant` for `person` and `chats`) |
| Who wrote a message | `speakerOf` (`units.ts`); units keep people unresolved, readers map them with `unitNow` |
| A local day or time | `localDate`, `dayStart` (`zones.ts`), `time` (`units.ts`), in the zone he was in (`zoneAt`), never the process's zone |
| Now | `clock()` (`src/clock.ts`), never `new Date()` or `Date.now()`; a duration is `performance.now()` |
| A source's behaviour | its descriptor in `SOURCES` (`src/sources/index.ts`); branch on kind or capability, never on its name; tables of sources come from `tablesOf` |
| Units for a memory step | `gather` (`units.ts`), once per sweep |
| A unit's words | `raw.ts` (`voiceLines`, `chatLines`, `unitLines`); a failed fetch throws |
| A message's files as lines | `showFiles` (`memory/files.ts`); readers resolve to `SourceFile`; `describeFiles` reads each once |
| Running another program | `src/proc.ts` |
| The lifelog store / the search index | `withStore` / `readIndex` (synchronous) and `buildIndex` (one WAL transaction) |
| A run's start and end | `record` (`src/memory/run.ts`) |
| Writing a secret file | `writeSecret` or `secretIn` (mode 600, which keeps it out of exports) |

Only `guard.ts`'s schedules and the status plate's waking hours (`waking`, `plate.ts`) follow the Mac's clock.
`LIFE_NOW` stops the clock for the agent bench only, on a copy of the data in a worktree of its own; a frozen run acts
on and sends nothing (`unfrozen` in remctl, `forward`, `sendReport`, the events' `post` and the Past calendar).

## Gotchas

- Every worktree reads and writes the same live data and lock. Point `LIFE_DATA` at a copy to experiment; copy
  `derived/settings.json` into a worktree before model runs. `bun test` uses its own made-up copy.
- The formatter sorts object keys: never let a key order carry meaning (use an array).
- `derived/` is generated; its rules load from `.claude/rules/derived.md` when you touch it.
- lifelog is read through its REST API; the zod shapes accept every null and absent field its contract allows
  (`lifelog.test.ts` checks them against lifelog's `openapi.json` when that repo is beside this one).
- The watcher hears a conversation only once its speech is complete; `CLOSED_ON_SILENCE_S` mirrors lifelog's rule
  (`docs/operations.md`).
- Codex is pinned in `package.json` and runs with its own `CODEX_HOME` (`docs/operations.md`).
- Secrets live in `.env` (gitignored) or the Keychain: never print or commit them.

## Boundaries

**Always:** run `bun run check` before committing; work in a worktree (the live checkout may be what runs the owner's
Life); measure a change to moments or extraction (`docs/operations.md`, "Measuring"); write an architectural decision
or invariant you make into this file or the doc it belongs to.

**Ask first:** a new table in the archive; re-running the whole archive through a model; bumping a prompt version;
removing a regression case; anything that spends the owner's model quota heavily (the bench, a backfill); changing
`docs/agent.md` (it changes the agent's behaviour and its seal).

**Never:** commit anything of his; hand-edit or wipe `memory/`; touch the archive's files; push or add a remote to the
data repo; add a send, a connector tool or an action; act or send on recorded content; print secrets; merge without the
owner's OK.

## Workflow

- A branch and a PR per change, small commits. Prefer deleting code to adding it; one way to do each thing; docs stay
  short and written for humans.
- Every PR passes a debt review before merge (the `debt-review` skill where available): architecture first, did it add
  or reduce debt?
- A bug fix merges with its regression case (a failing-then-passing `bun test` with made-up data, or graded facts for
  a model stage): `docs/operations.md`, "Regression cases".
- A PR that changes `prompts/`, `docs/agent.md` or the owner's `playbook.md` says which cases of those stages it
  re-checked and how they came out. The agent end to end is `bun scripts/bench-atlas.ts`.
