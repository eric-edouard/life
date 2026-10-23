# Glossary

Reference: every word Life uses for one of its concepts, with what it means. One word per concept, the same in the
docs, the app, the email, the connector and the code. A name that is not here is a plain English word.

**Word** is the name in code and stored data today. **Planned** is a decided rename that hasn't landed yet: until it
does, code and stored data use the Word, and the PR that lands it moves the new name into Word. Stored values and
their formats are in [SCHEMA.md](SCHEMA.md).

## People

| Word | Means | Planned |
|---|---|---|
| owner | The one person whose life Life holds. Stored as `person:me`. In the app and user docs, "you". A task waiting on him is `waiting-owner`. | |
| agent | The owner's assistant that takes his asks (a ChatGPT or Claude agent). Its display name is the `agent` setting (`agentName`); the word stored for it is `AGENT_WORD`, `agent`. | |
| speaker | Who said a turn in a recording. | |
| sender | Who wrote a message in a chat or mail. | |

## The agent's work

| Word | Means | Planned |
|---|---|---|
| ask | The owner's words handed to the agent: from "hey &lt;agent&gt;" in a recording, a Claude session or the agent's own split. A ledger entry of kind `ask`. | |
| task | The agent's work on one ask: the ask and the updates and replies that follow, open until the agent closes it done or dropped. | |
| update | The agent's report on a task: its state, steps, outcome; `taken: true` when it takes the task. | |
| reply | What the agent tells the owner, logged before it sends it. | |
| board | The agent's own list in the owner's to-do list, one item per open task. | |
| grant | The owner's standing permission for Life to add his clear to-dos to his to-do list. | |

## The ledger and the to-do list

| Word | Means | Planned |
|---|---|---|
| ledger | `memory/ledger.jsonl`: every line where something crossed Life's boundary: the owner's asks and grants, the agent's updates and replies, Life's changes to his to-do list. Append-only. | |
| ledger entry | One line of the ledger (`LedgerEntry`, id `entry_…`). Its `via` says through what it came: a session, the connector, the watcher, the to-do list. | |
| to-do list | Where Life acts: the owner's Apple Reminders or Google Tasks, one per install (the `todo_list` setting, `TodoListBackend`, `todo-list/`). | |
| to-do item | One entry in the to-do list (`TodoItem`). | |
| act | The one command that decides and makes a change to a to-do item, and logs it in the ledger. | |
| open item | Anything owed, derived, never stored (`openItems`): a to-do, a promise, a reply owed, a to-do item, someone the owner is waiting on. | |

## Sources

| Word | Means | Planned |
|---|---|---|
| source | Where Life reads from, named after the app or service: `lifelog`, `whatsapp`, `imessage`, `beeper`, `mail`, `notes`, `git`, `claude`, `chatgpt`, and the agent's. | |
| kind | What a source is to the memory: `voice`, `chat`, `mail`, `own_writing` (the owner's own words: Apple Notes, his imported assistant chats), `repo`, `agent`. | |
| Voice | The voice source as the owner sees it: his recordings, through lifelog. | the app's card, Pendant today |
| chapter | One recording in lifelog. | |
| archive | Life's own copy of the WhatsApp, Beeper and Notes stores, the only live copy of deleted messages and old note versions. | |

## The memory

| Word | Means | Planned |
|---|---|---|
| unit | The smallest piece Life reads: one chapter, a chat's day, a mail thread's day, a note's day, a repo's day. Id `unit_…`. | |
| verdict | A unit's judgement: its type, importance and area, with the reason. Only that. | |
| moment | A stretch of the owner's day, read from the day's units together. Id `mom_…`. | |
| observation | One small dated reading of a moment, with a quote checked against its source: a model's reading, not a verified fact. Id `obs_…`. | |
| type | What an observation is: `to_do`, `promise`, `waiting_on_someone`, `decision`, `about_a_person`, `preference`, `idea`, `news`, `nothing` (SCHEMA.md, "Words used below"). | |
| modality | How an observation holds: `fact`, `plan`, `reported`, `conditional`. | |
| importance | How much something matters to the owner: a unit's or an observation's 0–3, a moment's 1–3 (SCHEMA.md). | |
| page | A person's or an area's page, written from their observations. | |
| area, project | A part of the owner's life or work, and a project inside one, from `truth/`. | |
| truth | `truth/`: the owner's own files (people, areas, projects, goals). Only he writes them. | |
| correction | The owner's fix to the memory (`corrections.jsonl`). | |
| label | The owner saying something matters or doesn't (`labels.jsonl`). | |
| the check | The page where the owner rates statements true or false (`/check`): `statements.jsonl`, `ratings.jsonl`, and the eval's `scores.jsonl` (`EvalScore`). | |
| inferred | What Life guessed and uses until corrected: `people-inferred.jsonl` (`InferredPerson`, id `inf_…`), `repos-inferred.jsonl` (`InferredRepo`). | |
| closeness | How close a person is (`inner`, `regular`, `acquaintance`, `faded`), which decides who gets a page. | |

## The voice half

| Word | Means | Planned |
|---|---|---|
| Life for iPhone | The iPhone app (`apps/ios`), with its Watch app and widgets: drains the recorder, keeps every page, uploads speech. Shown as Life; its stored ids still say lifelog. | |
| recorder | The wearable that hears the owner's day: a Limitless Pendant or an Omi. | |
| voice server | `apps/voice`: takes the phone's speech, transcribes it, groups it into conversations and speakers, one SQLite archive. Was lifelog's server. | |
| speech service | `apps/speech`: audio in, numbers out (speaker embeddings, and a block's speaker turns, language per turn and words), nothing stored. | |
| transcriber | Who transcribes a block: `scribe` (ElevenLabs Scribe, whole) or `speech` (the speech service, Scribe for the turns it routes). The owner's switch picks it; a job keeps the one it was sent with. | |
| routed turn | A speaker turn the speech service leaves to Scribe: neither English nor French, or no words from it. | |
| dictation sensor | `apps/dictation`'s helper: tells the voice server when the owner dictates to the Mac, so that audio is never processed; runs the voice server's model calls on his subscription. | inside Life.app (step 9) |
| Voice Host | The menu-bar app that runs the voice server and the dictation sensor on a Mac (`apps/dictation`). | retired (step 9) |
| transcription bench | `apps/transcription-bench`: Scribe against open models on the owner's clips, hand-run. Not the bench, which measures Life's model steps. | |

## Running

| Word | Means | Planned |
|---|---|---|
| Past calendar | The calendar Life writes every moment that happened to, one event each (the `past` setting). Life's output, never a source. | |
| sweep | A scheduled batch of steps: `nightly`, `midday`, `backfill`. | |
| run | One step's run inside a sweep, logged with its counts. | |
| headless | Life without the app: `bun life headless` keeps the archive and the watcher running and ticks the nightly, a server container's command (`host/headless.ts`). | |
| watcher | The always-on service: every minute it folds in lifelog, hears asks, delivers them and syncs the board. | |
| tick | The watcher's minute. Only that. | |
| status | Whether Life works and how fresh it is. | |
| status snapshot | Every part of Life as a card, what the app's status window and menu-bar panel show (`host/status/snapshot.ts`, the local `/status/snapshot`). | |
| status page | The status snapshot in a browser, `/status/` on the public port behind the owner's sign-in: how a server install is watched. | |
| status reads | Life's read-only JSON about itself: the connector's `read_life_status`, `read_processing_runs`, `read_memory_changes` and `read_observation` (`docs/status-reads.md`), and the app's local `/status/*` (`host/http/status-reads.ts`). | |
| connector | Life's MCP server (`/mcp`), which ChatGPT and Claude call. Its tools say what they do: `read_…` reads, `correct_memory`, `change_todo_item`, `update_agent_task` and `log_reply_to_owner` write; `search` and `fetch` keep ChatGPT's names. | |
| record | One of the zod schemas of what Life writes, in `apps/server/src/records/`, one file per record (`unit.ts`, `moment.ts`, `ledger-entry.ts`…). | |

## Folders

| Word | Means | Planned |
|---|---|---|
| owner data dir | The owner's data repo: `truth/`, `memory/` (`OWNER_DATA_DIR`, env `LIFE_OWNER_DATA_DIR`). No git remote, ever. | |
| Life state dir | Life's own state: settings, log, the search index (`LIFE_STATE_DIR`, env too). | |
| machine dir | One per computer: the archive, the locks, Codex's home (`MACHINE_DIR`). | |
| Life code dir | Life's code, prompts and assets (`LIFE_CODE_DIR`, env too). | |
| time zone | Where the owner was, for local days (`zones.jsonl`, `zones.ts`). | |
| boundary zone | One layer of the code in fallow's checks (`.fallowrc.json`). | |

Next: the [architecture](architecture.md) and [every record](SCHEMA.md).
