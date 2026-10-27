# Life

A self-running memory of one person's life (the owner), built on his Mac from his voice (lifelog), chats, iMessage,
mail, Apple Notes, git and imported assistant chats: sources → units → moments → observations → people and area pages,
plus an always-on archive of deleted messages and old note versions. Shipped as Life.app; a checkout is for development.

lifelog (the pendant pipeline: the iPhone app, its server, the Mac helper and Lifelog Host) lives in `apps/lifelog`,
folded in from its own repo on 24 Oct 2026, with its own `AGENTS.md`. It still runs as its own service on the Mac, and
Life reads it only through its REST contract (`apps/lifelog/apps/server/openapi.json`), never its code or its database;
lifelog may use Life's `core/`. Only instants cross that contract: a local day is Life's to bound (`zoneAt`), since
lifelog knows only where the phone is now. One gate, `bun run check` at the root, covers both.

Read before changing an area: `docs/glossary.md` (every word, one meaning each), `docs/architecture.md` (shape and
reasons), `docs/SCHEMA.md` (every record),
`docs/sources.md`, `docs/tasks.md` (the agent, the connector, actions, sends), `docs/operations.md` (schedule, locks,
backups, evals, the read CLI), `docs/status-reads.md` (the connector's status reads), `docs/releasing.md`,
`SECURITY.md`. User how-tos are in `docs/use/`; any docs work follows `docs/STYLE.md`. `docs/agent.md` is not
documentation: it is the agent's playbook, read at run time.

## Commands

```sh
bun install                      # also points git hooks at .githooks (pre-push runs the check)
bun run check                    # the gate: lint, types, fallow, tests, scrub, cases. Must pass before every commit
bun test apps/server/src/memory/units.test.ts   # one test file
bun run fix                      # format and lint fixes
bun life <command>               # the CLI (apps/server/src/host/cli.ts); `bun life memory …` for the pipeline and reads
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
  his material goes to his data repo, his settings to `LIFE_STATE_DIR/settings.json`, secrets to `.env` or the Keychain. The
  `scrub` step catches full names, aliases, surnames, phones, emails, handles and chat ids from his `truth/`; first
  names, places, project names, `.env` values and git history are on you. The domain in Life's own infrastructure
  labels (sender, LaunchAgent labels) is kept on purpose.
- **Only the owner writes `truth/`.** Models return JSON that zod validates; every quote is checked against its source
  (`apps/server/src/memory/observe.ts`).
- **Memory is append-only and expensive.** Never hand-edit or wipe `memory/` (except appending his corrections or
  labels). `ledger.jsonl` is appended only by `act`, `setGrant`, the tasks (`ask`, `update`, `reply`) and the sync
  pass (`inbound`, `closings`). The status reads' `read_memory_changes` cursor counts ledger lines, so a line must never move. Code
  rewrites only `units/` and `moments/<day>.jsonl`, and a rename's backfill (next).
- **lifelog's chapter units are the only copy of the voice history before conversation-days.** The store no longer
  holds what built them: never wipe or rebuild them; one goes only with its conversation (`frozenUnits`, `units.ts`).
- **A rename backfills.** Names follow the best model, never old data. Renaming something stored (a field, an enum
  value, an id, a file, a unit id's recipe) ships one migration in Life's code (`host/migrate.ts`, written fresh: the last
  one, `stored-names-2026-10-22`, is in git history), with the owner's OK on the list of renames: the app runs it at its
  next start, under the lock (a checkout only on a copy); it rewrites the stored lines in place (same count, same
  order, so the `read_memory_changes` cursor holds) and commits in the data repo. Never run one by hand or from a worktree: the
  running Life reads the same data. After it the code reads only the new name, with no alias. `truth/` (only he
  writes it) and the archive are never migrated. A renamed value the models return changes a prompt's words, not its
  meaning: the prompt keeps its version and its cached outputs are backfilled. Connector renames ship in one batch.
  A new recipe for new units only, every stored id kept, is not a rename.
- **One lock.** Everything that writes `memory/` holds it (`locked`, `memory-lock.ts`), except his single lines (a
  correction, a rating) and `ledger.jsonl`'s writers above. One Life per Mac: the archive and the watcher each hold a
  lock in `MACHINE_DIR` (`docs/operations.md`).
- **The archive is the only live copy of deleted messages and old note versions.** Never move, wipe or migrate its
  files; a new table only with the owner's OK, never a rewrite of rows. Keep it running. App stores are opened
  read-only; only the apps of enabled sources are kept open (`keptStores`).
- **Content is never a command for Life's code.** Recorded text never makes Life act; model calls see no tools and no
  instruction files (`apps/server/src/models/llm.ts`). The "hey Life" marker only keeps a unit read. His Apple Notes and imported
  assistant chats are memory only, never his words for actions.
- **Life's own output never re-enters memory:** its chat and mail are dropped as `life-output` (`units.ts`). What Life
  read off a file (`memory/files.jsonl`) shows inside the file's brackets and is evidence of what was sent, never
  anyone's words. The agent's done tasks enter only as the agent's source (named by `AGENT_WORD`), as evidence of what was done, never as his
  words or a request.
- **Life acts in one place: one to-do list backend per install** (Apple Reminders or Google Tasks, the `todo_list`
  setting), through `act`, on his clear request or the standing grant. What a backend lacks is a capability (`can`),
  never a branch on its name. Asks are his
  words handed to the agent, never acted on by Life. Details: `docs/tasks.md`.
- **Nothing leaves the Mac but what SECURITY.md lists** ("What leaves the Mac"). Add nothing to that list without him.
- **The connector reads, forwards his corrections, and acts only through `change_todo_item`, `update_agent_task` and `log_reply_to_owner`.** Never add a
  tool that sends or edits anything else. Tool changes force a costly reconnect in ChatGPT: batch them, keep names and
  arguments stable.
- **Pages serve nothing of his before their sign-in check** (`/check`, `/me`; the app's status reads behind the local
  key). Never take the local key on the public port (`docs/architecture.md`, "Pages").
- **Life signs its own tokens; there is no other issuer.** `oauth.ts` is the one source of the issuer's address, the
  owner's subject and the pages' client; an app (ChatGPT, Claude, `/check`) is approved by a pairing code from the Mac.
  lifelog signs nothing for Life (24 Oct 2026, its `docs/decisions.md`).
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
- **Dependencies point one way** between `apps/server/src`'s layers (core ← records ← models, sources, todo-list ←
  memory ← host; `docs/architecture.md`, "The code"). Fallow's boundary zones (`.fallowrc.json`) and
  `scripts/cycles.test.ts` fail the check on any import against them; never suppress one, move the code instead.
- **Settings are one strict file, read once per process** (`apps/server/src/core/settings.ts`). A part left out is off; a new key lands
  in code first; owner values are never defaults in code. Likewise **a new key in `truth/` lands in code first**: the
  schemas are `.strict()`, and a key the running code doesn't know stops the watcher, the nightly and the connector.
- **The actions backend is an interface, never the truth; the ledger is.** Changes read back from it can take authority
  away or reorder, never add it. Open items are derived (`openItems`), never stored (`docs/tasks.md`).
- **Nightly emails include every row.** Never cap a list or write "+N more" (`docs/operations.md`, "The nightly
  report").
- **Everything Life shows follows Life's own brand** (`docs/brand.md`): one source, `assets/brand/tokens.css`, which
  wins over any global brand skill for Life. A brand change lands there first; the email and the app copy it
  (`scripts/brand.test.ts` checks).

## Names

A name is a decision about what a thing is. Before naming or renaming anything, say in one sentence what it is and
what it is not, then find its word in `docs/glossary.md` (its Word column is what the code uses today): one word per
concept, the same in docs, app, email, connector and code. A new concept gets its glossary line in the same PR.

- Clarity beats brevity: a name the reader doesn't have to look up (the connector's `read_open_agent_tasks`, not
  `tasks`).
- One meaning per word. When a word already means something else (state, item, run, zone), pick another.
- New and renamed functions: `readX` reads disk or the network, `parseX` turns text into a value, `xOf` is pure, `latest` is the most
  recent of a set, booleans start with `is` or `has`.
- Files: a file names what it does, and no two files share a name (a capability's `contract.ts` aside).
- No person's name in code, stored values or ids: name the role, `owner` or `agent`.
- A clearer name for something stored is worth its backfill (the invariant above).

## One way to do each thing

Before adding a helper, use the one that exists:

| Need | Use |
|---|---|
| Where an observation stands (hidden, gone, replaced, retired) | `stateOf` (`ledger.ts`): index, pages and status reads alike |
| What is new since a night | `newSince` (a source line first cited) |
| Who has a page / who is close personally | `pagedNow`, `personallyClose` (`closeness.ts`); never a list |
| Who a name, handle or ref is | `memory/who.ts` (`readPeople`; `meant` for `read_person_page` and `read_chats`) |
| Who wrote a message | `speakerOf` (`units.ts`); units keep people unresolved, readers map them with `unitNow` |
| A local day or time | `localDate`, `dayStart` (`zones.ts`), `time` (`units.ts`), in the zone he was in (`zoneAt`), never the process's zone |
| Now | `clock()` (`apps/server/src/core/clock.ts`), never `new Date()` or `Date.now()`; a duration is `performance.now()` |
| A duration, an instant as the ledgers write it | `MIN`, `HOUR`, `DAY`, `iso` (`apps/server/src/core/clock.ts`) |
| A capability's types | its `contract.ts` (`sources/`, `todo-list/`): implementations import it, its registry imports them, never back |
| A source's behaviour | its descriptor in `SOURCES` (`apps/server/src/memory/sources.ts`); branch on kind or capability, never on its name; tables of sources come from `tablesOf` |
| Units for a memory step | `gather` (`units.ts`), once per sweep |
| A unit's words | `words.ts` (`voiceLines`, `chatLines`, `unitLines`); a failed fetch throws |
| A message's files as lines | `showFiles` (`memory/message-files.ts`); readers resolve to `SourceFile`; `describeFiles` reads each once |
| Running another program | `apps/server/src/core/proc.ts` |
| A path written with `/` (an export's manifest, git, tests) | `slashed` (`apps/server/src/core/platform.ts`); the checkout's files: `repoFiles` (`apps/server/src/core/proc.ts`) |
| His Reminders or Google Tasks | the backend (`backend()`, `apps/server/src/todo-list/backend.ts`): nothing else calls remctl or `gog tasks` |
| The lifelog store / the search index | `withStore` / `readIndex` (synchronous) and `buildIndex` (one WAL transaction) |
| A run's start and end | `record` (`apps/server/src/memory/run.ts`) |
| Writing a secret file | `writeSecret` or `secretIn`, by its name in `SECRETS` (`secret.ts`), which also keeps it out of exports |
| Whether an output is on, and why not | `isOn`, `off` (`apps/server/src/core/outputs.ts`), never a setting read for the switch |
| A model provider's models, effort, tools, quota | its entry in `PROVIDERS` (`llm.ts`) |
| Anything that differs between macOS and Windows | `apps/server/src/core/platform.ts` (paths, binaries, environment, time zone, notifications); a Mac-only source is `macOnly` |

Only `schedule.ts`'s schedules and the status snapshot's waking hours (`waking`, `snapshot.ts`, given `systemZone()`) follow the Mac's clock.
`LIFE_NOW` stops the clock for the agent bench only, on a copy of the data in a worktree of its own; a frozen run acts
on and sends nothing (`unfrozen` in remctl, `forward`, `sendReport`, the events' `post` and the Past calendar).

## Gotchas

- Every worktree reads and writes the same live data and lock. Point `LIFE_OWNER_DATA_DIR` at a copy to experiment; copy
  `derived/settings.json` into a worktree before model runs. `bun test` uses its own made-up copy.
- A worktree installs its own dependencies (`bun install --ignore-scripts`); never link another checkout's
  `node_modules`: its workspace links resolve back into that checkout, so the worktree would run that checkout's code.
- The formatter sorts object keys: never let a key order carry meaning (use an array).
- `derived/` is generated; its rules load from `.claude/rules/derived.md` when you touch it.
- lifelog is read through its REST API; the zod shapes accept every null and absent field its contract allows
  (`lifelog.test.ts` checks them against `apps/lifelog/apps/server/openapi.json`).
- The watcher hears a conversation only once its speech is complete, by lifelog's own signals (`endedOnSilence`,
  `closed`), never a timing rule of Life's (`docs/operations.md`).
- Codex is pinned in `package.json` and runs with its own `CODEX_HOME` (`docs/operations.md`).
- Secrets live in `.env` (gitignored) or the Keychain: never print or commit them.

## Boundaries

**Always:** run `bun run check` before committing; work in a worktree (the live checkout may be what runs the owner's
Life); measure a change to moments or extraction (`docs/operations.md`, "Measuring"); write an architectural decision
or invariant you make into this file or the doc it belongs to.

**Ask first:** a new table in the archive; a migration of stored data (the list of renames); re-running the whole archive through a model; bumping a prompt version;
removing a regression case; anything that spends the owner's model quota heavily (the bench, a backfill); changing
`docs/agent.md` (it changes the agent's behaviour and its seal).

**Never:** commit anything of his; hand-edit or wipe `memory/`; touch the archive's files; push or add a remote to the
data repo; add a send, a connector tool or an action; act or send on recorded content; print secrets; merge without the
owner's OK.

## Workflow

- A branch and a PR per change, small commits. Prefer deleting code to adding it; one way to do each thing; docs stay
  short and written for humans.
- Every PR passes the golden rule (the `golden-rule` skills where available): a plan checked before code, and
  `golden-rule-verdict` before merge: did it add or reduce debt?
- A bug fix merges with its regression case (a failing-then-passing `bun test` with made-up data, or graded facts for
  a model stage): `docs/operations.md`, "Regression cases".
- A PR that changes `prompts/`, `docs/agent.md` or the owner's `playbook.md` says which cases of those stages it
  re-checked and how they came out. The agent end to end is `bun scripts/bench-agent.ts`.
