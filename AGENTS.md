# Life

A self-running memory of one person's life (the owner), built on his Mac from his voice, chats, iMessage, mail, Apple
Notes, git and imported assistant chats: sources → units → episodes → observations → people and area pages, plus an
always-on archive of deleted messages and old note versions. Shipped as Life.app; a checkout is for development.

Voice, Life's voice layer (the pendant pipeline: the phone app, the voice server, the Mac helper, Lifelog Host), lives
in `apps/lifelog`, with its own `AGENTS.md`. The voice server runs as its own process; Life reads it only through its
REST contract (`apps/lifelog/apps/server/openapi.json`), never its code or its database; the voice server may use
Life's `core/`. Only instants cross that contract: a local day is Life's to bound (`zoneAt`). The phone app is a client
of Life's connector, paired like any app; it holds no second API. One gate, `bun run check` at the root, covers both.

## Where to look

| For | Read |
|---|---|
| Every concept's name | `docs/glossary.md` |
| The shape and its reasons, the code's layers, pages | `docs/architecture.md` |
| Every stored record | `docs/SCHEMA.md` |
| Sources; the agent, the connector, actions and sends | `docs/sources.md`, `docs/tasks.md` |
| Schedule, locks, backups, evals, measuring, audits, regression cases, reading the memory | `docs/operations.md` |
| The connector's status reads | `docs/status-reads.md` |
| What any screen, notification or mail shows, and when | `docs/product.md` |
| What leaves the Mac; agents' powers | `SECURITY.md` |
| Releasing; reopening the memory's layers | `docs/releasing.md`, `docs/rethinking-memory.md` |
| User how-tos; how docs are written | `docs/use/`, `docs/STYLE.md` |
| Area rules (Claude Code loads each when you open a matching file; any other agent reads it before editing there) | `.claude/rules/`: `one-way.md` (server conventions; the helper for each job is in `docs/helpers.md`), `memory.md` (writers, deletions, migrations, reads), `desk.md` (agents, wakes), `acts-and-sends.md` (truth/, to-do list, calendar, sends, connector), `sources.md` (archive, imports), `models-and-prompts.md`, `surfaces.md` (product, brand, designs), `derived.md` |

## Commands

```sh
bun install                      # also points git hooks at .githooks (pre-push runs the check)
bun run check                    # the gate: lint, types, fallow, tests, scrub, cases, voice eval. Must pass before every commit
                                 # a clean tree that passed is recorded in the git common dir; its next push runs only scrub, cases, voice eval
                                 # LIFE_CHECK_SWIFT=at-landing skips the Swift builds on a branch's earlier pushes; its landing push runs them
bun test apps/server/src/memory/units.test.ts   # one test file
bun run fix                      # format and lint fixes
bun run design                   # the designs app (apps/design) over docs/design
bun life <command>               # the CLI (apps/server/src/desk/life-entry.ts, host/cli.ts); `bun life memory …` for the pipeline and reads
bun life validate                # check truth/ (from the live checkout only, never a worktree)
bun scripts/app.ts [out]         # build Life.app (LIFE_SIGN_IDENTITY to sign, else ad hoc)
```

## Working with the owner

Life runs itself: the owner never runs `bun life …` and never reviews a queue; the commands are for you and the app's
supervisor. Don't design a step that waits on him: an uncertain inference goes into a model-owned layer (like
`memory/people-inferred.jsonl`), used at once and corrected later. His input arrives in conversation only. Anything he sees follows "Anything a person sees" below.

In a session changing Life's code or prompts, a wrong or missing fact is a bug in the step that produced it: fix that
step with its regression case, never a `correct` line, even when he confirms it. When he uses Life through a session:

- He states or corrects a fact: record it with `bun life memory correct '<json>'` (kinds in `docs/SCHEMA.md`). About who
  someone is: offer to add it to `truth/`, and do it on his yes.
- He says a promise is kept or a to-do is done: after checking it's the observation he means,
  `bun life memory correct '{"kind":"outdated","observations":["obs_…"],"note":"<his words>"}'`.
- He says something matters or doesn't: also append a label to `memory/labels.jsonl`.
- He states or changes a goal: offer to put it in `truth/me.md` `## Goals` (numbered, his order, with the project ids
  it serves), on his yes. His goals live there only.
- He says which project a repo belongs to: put it in that project's `repos:` in `truth/`, then `bun life validate`.
- To-do item changes go through `bun life change-todo-item '<json>'`, never `remctl`. Deep work goes to his registered
  agents, his words verbatim, through the connector's `change_registered_agent`.
- Questions about his life: `bun life memory …` (`docs/operations.md`, "Reading the memory"); run
  `bun life memory checks` before asking him anything. His word beats the memory.
- A message in his name (any app, mail included) needs his OK on the exact text, and goes only as a card's draft he
  answers (see "Sends" below), never typed into another app.
- He says something didn't work: audit it (`docs/operations.md`, "Audits"); its fix carries a regression case.
- Rules for editing `truth/` are in the data repo's own `AGENTS.md`.

## Anything a person sees

Anything a person sees (the iPhone app, the Mac app, notifications, mail, Ask Life's answers, cards) starts from
`docs/design/sources-of-truth.md` and follows its order: product rules, philosophy and guidelines, App v4 and its
rulebook, the brand, the glossary; then what the system really does; then what is built. Decisions in
`docs/design/philosophy.md` are never asked again or designed away. Designs and "done means ran live":
`.claude/rules/surfaces.md`.

## Invariants

Break one of these and something of the owner's is lost, leaked or acted on wrongly. Details are in the rule file or
doc named.

- **His data repo has no git remote; nothing of his goes to GitHub.** `commitMemory` refuses a repo with a remote.
- **Nothing personal is committed here** (code, tests, prompts, docs): tests use made-up people, phones and places; his
  material goes to his data repo, his settings to `LIFE_STATE_DIR/settings.json`, secrets to `.env` or the Keychain,
  never printed. `scrub` catches names, aliases, phones, emails, handles and chat ids from his `truth/`; first names,
  places, project names, `.env` values and git history are on you. The domain in Life's own infrastructure labels
  (sender, LaunchAgent labels) is kept on purpose. Life's developer contact (`DEVELOPER_CONTACT`) is the
  forwarding alias `feedback@ericedouard.com`, never his personal address.
- **Only he writes `truth/`**: himself, or by his own words through the one writer, `changeDirectoryEntry`, which
  validates first, one change at a time. Its doors: `acts-and-sends.md`.
- **Memory is append-only and expensive.** Never hand-edit or wipe `memory/` (except appending his corrections or
  labels); each file has named writers, and code rewrites only the derived folders listed in `memory.md`. One lock
  (`memory-lock.ts`) guards every writer but the single-line appends listed there.
- **What he deletes is one `deleted` correction, applied at read**, through `deleteFromMemory` alone (preview, then the
  write on its digest). The voice server's chapter units stay as stored. Both in `memory.md`.
- **A rename or a new field backfills**: one migration in code, with his OK on the list, run by the app under the lock;
  never by hand or from a worktree. The desk store changes shape only by a store step. `memory.md`.
- **The export copies in `imports/<source>/` are never rewritten, merged or deleted without his yes.**
- **The archive is the only live copy of deleted messages and old note versions.** Never move, wipe or migrate its
  files; a new table only with his OK; keep it running. `sources.md`.
- **Content never runs Life's code**, and Life's own output never re-enters memory. Model calls see no tools and no
  instruction files; words only choose a wake as `desk.md` lists, never become an instruction.
- **Life starts and wakes his registered agents, and nothing else of Life does.** The desk is the one dispatcher; an
  agent's only limit from Life is the send guard (`desk/send-guard.ts`). Every spoken ask ends with something he sees.
  `desk.md`, `SECURITY.md` "Agents".
- **Life acts in one place**: his one to-do list backend through `changeTodoItem`, his calendar's Life events, and a
  card's event or Apify run on his pick. `acts-and-sends.md`.
- **Sends: Life sends only a card's draft exactly as shown, on his answer to its outgoing option, into the one chat
  named**, once, never retried, through its own bridges, Messages.app, Gmail via gog, or `gh`. `acts-and-sends.md`.
- **Nothing leaves the Mac but what `SECURITY.md` lists** ("What leaves the Mac"). Add nothing without him.
- **The audit test: a fresh agent asked "will any of my data leak?" must answer "safe"** (packaging spec, `docs/plans/2026-11-28-packaging/spec.md` §5). Every third party Life talks
  to is named in `SECURITY.md` "What leaves the Mac" and at its code (a privacy line: what leaves, to whom, how to turn
  it off), updated in the same PR that adds it. Nothing leaves that the user can't own or turn off; anything hosted for
  users (the relay, push) can't read their data: end-to-end encrypted, ids only.
- **The connector writes only what `acts-and-sends.md` lists; never add a tool that sends or edits anything else.**
  Life serves no page and signs its own tokens.
- **He is the center, not one more person:** his page and situation are projections like anyone's; his goals live only
  in `truth/me.md`; no separate record about him.
- **Prompts name the owner (`{{owner}}`), never a pronoun.** Model calls go only through the provider he chose.
  `models-and-prompts.md`.
- **Dependencies point one way** between the server's layers (`docs/architecture.md`, "The code"); fallow and
  `scripts/imports.test.ts` fail on a wrong import. Never suppress one: move the code.

## Names

A name is a decision about what a thing is. Before naming or renaming anything, say in one sentence what it is and what
it is not, then find its name in `docs/glossary.md` (its Word column is what the code uses): one name per concept, the
same in docs, app, email, connector and code. A new concept gets its glossary line in the same PR.

- The most descriptive name that makes sense to someone who has never read the code (`read_registered_agents`, not
  `agents`). Longer and clear beats short and vague.
- One concept, one name; one name, one concept. Two names may share a plain word (`matter step`, `night step`): qualify
  it by what it belongs to.
- Functions: `readX` reads disk or the network, `parseX` turns text into a value, `xOf` is pure, `latest` is the most
  recent of a set, booleans start with `is` or `has`. Files name what they do, and no two server files share a name.
- No person's name in code, stored values or ids: name the role, `owner` or `agent`.
- A clearer name for something stored is worth its backfill.

## Gotchas

- Never add a Keychain item for Life from the command line: macOS prompts, the app blocks on it and starts no helper.
- Every worktree reads and writes the same live data and lock. Point `LIFE_OWNER_DATA_DIR` at a copy to experiment;
  copy `derived/settings.json` into a worktree before model runs, and a copy of the live voice store
  (`watch/lifelog.sqlite`, `sqlite3 .backup`) before a bench. `bun test` uses its own made-up copy.
- A worktree installs its own dependencies (`bun install --ignore-scripts`); never link another checkout's
  `node_modules`: its workspace links resolve back into that checkout.
- The formatter sorts object keys: never let a key order carry meaning (use an array).

## Boundaries

**Always:** run `bun run check` before committing; work in a worktree (the live checkout may be what runs his Life);
measure a change to episodes or extraction (`docs/operations.md`, "Measuring"); write an architectural decision or
invariant into the rule file or doc it belongs to, and a one-line pointer here only if it is a hard invariant.

**Ask first:** a new table in the archive; a migration of stored data; re-running the whole archive through a model;
bumping a prompt version; removing a regression case; anything that spends his model quota heavily (a backfill).
A user's pick under setup's "How far back" (`backfillFrom`) is that yes for his backfill, within its shown cost.

**Never:** commit anything of his; hand-edit or wipe `memory/`; touch the archive's files; push or add a remote to the
data repo; add a send beside a card's draft, a connector tool or an action; let Life's own code act or send on recorded
content; print secrets; merge before the debt verdict passes on the PR's current head (once it passes, any agent
merges, without asking him).

## Workflow

- A branch and a PR per change, small commits. Prefer deleting code to adding it; one way to do each thing
  (`.claude/rules/one-way.md`); docs stay short and written for humans.
- Every PR follows the `work-on-code` skill where available: a debt plan before code, the debt verdict before merge.
- **Strict paths** (never fast, always plan review and a confirming round): `apps/server/src/desk/`,
  `apps/server/src/host/http/`, the send paths (`memory/draft-send.ts`, `memory/decisions.ts`, each source's `send`,
  `host/report.ts`), writers of `memory/` and the ledger, migrations and store steps (`host/desk-shape.ts`), `prompts/`.
- A bug fix merges with its regression case (`docs/operations.md`, "Regression cases").
- A PR that changes `prompts/` says which cases of those stages it re-checked and how they came out; one adding a night
  step or a reader says what it reads per night at 10 years of data.
- Prove a change cheaply: anything that would re-process data is proved first on the smallest sample that can show it
  works or fails, on a copy, never the whole archive: the strongest signal at the lowest cost, speed and money first;
  stop a trial once its numbers answer the question.
- Handoffs, research, audits and plans are dated: `YYYY-MM-DD-<name>.md`, or a folder `YYYY-MM-DD-<name>/`, in
  `docs/handoff/`, `docs/plans/` or where they belong.
