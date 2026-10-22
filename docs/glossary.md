# Glossary

Reference: every word Life uses for one of its concepts, with what it means. One word per concept, the same in the
docs, the app, the email, the connector and the code. A name that is not here is a plain English word. When a name
changes, its old spelling sits in **Formerly** until no code, doc or stored line uses it.

## People

| Word | Means | Formerly |
|---|---|---|
| owner | The one person whose life Life holds. Stored as `person:me`; a task waiting on him is `waiting-owner`. In the app and user docs, "you". | he, his, the owner's first name |
| agent | The owner's assistant that takes his asks (a ChatGPT or Claude agent). Its display name is the `agent` setting (`agentName`); the word stored for it is `agent` (`AGENT_WORD`). | `atlas` |
| speaker | Who said a turn in a recording. | author |
| sender | Who wrote a message in a chat or mail. | |

## The agent's work

| Word | Means | Formerly |
|---|---|---|
| ask | The owner's words handed to the agent: from "hey &lt;agent&gt;" in a recording, a Claude session or the agent's own split. A ledger entry of kind `ask`. | request |
| task | The agent's work on one ask: the ask and the updates and replies that follow, open until the agent closes it done or dropped. | |
| update | The agent's report on a task: its state, steps, outcome. A task it takes is marked `taken`. | `claim: true` |
| reply | What the agent tells the owner, logged before it sends it. | |
| board | The agent's own list in the owner's to-do list, one item per open task. | |
| grant | The owner's standing permission for Life to add his clear to-dos to his to-do list. | |

## The ledger and the to-do list

| Word | Means | Formerly |
|---|---|---|
| ledger | `memory/ledger.jsonl`: every line where something crossed Life's boundary: the owner's asks and grants, the agent's updates and replies, Life's changes to his to-do list. Append-only. | `actions.jsonl` |
| ledger entry | One line of the ledger (`LedgerEntry`), id `entry_…`. Its `via` says through what it came: a session, the connector, the watcher, the to-do list. | `Action`, `act_…`, `madeBy` |
| to-do list | Where Life acts: the owner's Apple Reminders or Google Tasks, one per install (the `todo_list` setting, `TodoListBackend`). | actions backend, reminders, lists |
| to-do item | One entry in the to-do list (`TodoItem`). | `Item` |
| act | The one command that decides and makes a change to a to-do item, and logs it in the ledger. | |
| open item | Anything owed, derived, never stored (`openItems`): a to-do, a promise, a reply owed, a to-do item, someone the owner is waiting on. | loop, Due |

## Sources

| Word | Means | Formerly |
|---|---|---|
| source | Where Life reads from, named after the app or service: `lifelog`, `whatsapp`, `imessage`, `beeper`, `mail`, `notes`, `git`, `claude`, `chatgpt`, `agent`. | input, channel |
| kind | What a source is to the memory: `voice`, `chat`, `mail`, `own_writing` (the owner's own words: Apple Notes, his imported assistant chats), `repo`, `agent`. | `notes` (as a kind) |
| Voice | The voice source as the owner sees it: his recordings, through lifelog. | Pendant |
| chapter | One recording in lifelog. | recording, conversation |
| archive | Life's own copy of the WhatsApp, Beeper and Notes stores, the only live copy of deleted messages and old note versions. | |

## The memory

| Word | Means | Formerly |
|---|---|---|
| unit | The smallest piece Life reads: one chapter, a chat's day, a mail thread's day, a note's day, a repo's day. Id `unit_…`. | L1, `u_…` |
| verdict | A unit's judgement: its kind, importance and area, with the reason. Only that. | triage |
| moment | A stretch of the owner's day, read from the day's units together. Id `mom_…`. | |
| observation | One small dated reading of a moment, with a quote checked against its source: a model's reading, not a verified fact. Id `obs_…`. | fact, claim |
| observation kind | `to_do`, `promise`, `waiting_on_someone`, `decision`, `about_a_person`, `preference`, `idea`, `news`, `nothing`. | `todo`, `waiting`, `person` |
| modality | How an observation holds: `fact`, `plan`, `reported`, `conditional`. | |
| importance | 0–3, how much something matters to the owner: 0 nothing to keep, 1 searchable only, 2 a line on a page, 3 he must act or must not forget. | salience |
| page | A person's or an area's page, written from their observations. | |
| area, project | A part of the owner's life or work, and a project inside one, from `truth/`. | |
| truth | `truth/`: the owner's own files (people, areas, projects, goals). Only he writes them. | the map |
| correction | The owner's fix to the memory (`corrections.jsonl`). | |
| label | The owner saying something matters or doesn't (`labels.jsonl`). | |
| the check | The page where the owner rates statements true or false (`/check`): `statements.jsonl`, `ratings.jsonl`, and the eval's `scores.jsonl` (`EvalScore`). | truth benchmark |
| inferred | What Life guessed and uses until corrected: `people-inferred.jsonl` (`InferredPerson`, id `inf_…`), `repos-inferred.jsonl` (`InferredRepo`). | guess, `inf-…` |
| closeness | How close a person is (`inner`, `regular`, `acquaintance`, `faded`), which decides who gets a page. | |

## Running

| Word | Means | Formerly |
|---|---|---|
| sweep | A scheduled batch of steps: `nightly`, `midday`, `backfill`. | |
| run | One step's run inside a sweep, logged with its counts. | |
| watcher | The always-on service: every minute it folds in lifelog, hears asks, delivers them and syncs the board. | |
| tick | The watcher's minute. Only that. | |
| status | Whether Life works and how fresh it is: the app's status window, the connector's `read_life_status`. | plate, dashboard |
| connector | Life's MCP server (`/mcp`), which ChatGPT and Claude call. | |
| record | One of the zod schemas of what Life writes, in `apps/server/src/records/`, one file per record. | schema.ts |

## Folders

| Word | Means | Formerly |
|---|---|---|
| owner data dir | The owner's data repo: `truth/`, `memory/` (`OWNER_DATA_DIR`, `LIFE_OWNER_DATA_DIR`). No git remote, ever. | `DATA`, `LIFE_DATA` |
| Life state dir | Life's own state: settings, log, the search index (`LIFE_STATE_DIR`). | `STATE`, `LIFE_STATE` |
| machine dir | One per computer: the archive, the locks, Codex's home (`MACHINE_DIR`). | `MACHINE` |
| Life code dir | Life's code, prompts and assets (`LIFE_CODE_DIR`). | `ROOT`, `LIFE_ROOT` |
| time zone | Where the owner was, for local days (`zones.jsonl`, `zones.ts`). | zone |
| boundary zone | One layer of the code in fallow's checks (`.fallowrc.json`). | zone |

Next: the [architecture](architecture.md) and [every record](SCHEMA.md).
