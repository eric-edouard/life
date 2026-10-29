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
| agent start | For an agent that pulls its asks: the command Life starts with an event's JSON appended, on a new ask (`{kind:"ask"}`) and each minute (`{kind:"tick", at, zone}`) (`agent.start`, `startAgent`); the command decides what each event starts. Never waited on; what it says on stderr as it exits non-zero is mailed to him, each line once (`agentSaid`). | |
| speaker | Who said a turn in a recording. | |
| sender | Who wrote a message in a chat or mail. | |

## The agent's work

| Word | Means | Planned |
|---|---|---|
| ask | The owner's words handed to the agent: from "hey &lt;agent&gt;" in a recording, a Claude session, the agent's own split, or his daily ask. A ledger entry of kind `ask`. | |
| mark | An ask's span in a recording, recorded by the hearing so its unit is read again at importance 3 (`marked` on the unit). Not a separate wake: "hey Life" is one of the agent's wake words. | |
| daily ask | An ask Life makes once a day from the owner's own text (the `daily_ask` setting), at the time he picked, in his time zone; its `ref` is `daily:<day>`. | |
| task | The agent's work on one ask: the ask and the updates and replies that follow, open until the agent closes it done or dropped. | |
| update | The agent's report on a task: its state, steps, outcome; `taken: true` when it takes the task. | |
| reply | What the agent tells the owner, logged before it sends it. | |
| send | Life's one send into a chat: the draft of the option he answered in a decision, into the chat its `ref` names (`<source>:<chat>`), once (`host/send.ts`, the ledger's `sent`). Not a reply (the agent to him). | |
| Sends | The output (`sends` setting) and its status card: whether Life can send the replies he chooses; a source whose `send.blocked()` says why not is shown there, never on its reading card. | |
| bridge | A program that links one of his messaging accounts to his local Matrix homeserver, so Life can send through it (`docs/use/bridges.md`). | |
| board | The agent's own list in the owner's to-do list, one item per open task. | |
| grant | The owner's standing permission for Life to add his clear to-dos to his to-do list. | |
| grant (a loop's) | A decision of `kind: "grant"`: a standing yes he gives one loop (its `ref`: autonomy, budget, publish, ads, mail); it stands while it is the newest done one of its loop and ref, with a scope, not revoked (`active`). | |

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
| source | Where Life reads from, named after the app or service: `lifelog`, `whatsapp`, `imessage`, `beeper`, `line`, `instagram`, `mail`, `notes`, `git`, `claude`, `chatgpt`, and the agent's. | |
| kind | What a source is to the memory: `voice`, `chat`, `mail`, `own_writing` (the owner's own words: Apple Notes, his imported assistant chats), `repo`, `agent`. | |
| Voice | The voice source as the owner sees it: his recordings, through lifelog. | the app's card, Pendant today |
| conversation | What lifelog groups the owner's speech into, by rules: Life's voice units come from its turns. | |
| turn | One speaker's stretch of a recording, cited `<job>:<turn>@<start>`. | |
| conversation-day | A voice unit: one conversation's turns on one local day, its words fetched only when its day is read. | |
| chapter | One of lifelog's summarized stretches of a conversation. A stored unit that is one (it carries lifelog's summary) is kept as stored, never built again, and its conversation gets no conversation-days. | |
| archive | Life's own copy of the WhatsApp, Beeper and Notes stores, the only live copy of deleted messages and old note versions. | |

## The memory

| Word | Means | Planned |
|---|---|---|
| unit | The smallest piece Life reads: a conversation-day (or a stored chapter), a chat's day, a mail thread's day, a note's day, a repo's day. Id `unit_…`. | |
| verdict | A unit's judgement: its type, importance and area, with the reason. Only that. | |
| moment | A stretch of the owner's day, read from the day's units together. Id `mom_…`. | |
| unkept | A unit Life read before that its latest verdict no longer keeps: its facts are replaced by none (`unkept` in extracted.jsonl). Not a dropped unit, which a code rule leaves out. | |
| kept both | A fact the memory both states and contradicts: a contradiction stored, counted apart from wrong by the eval and the bench. | |
| judge case | A fact with the claims a judge saw and the grade the owner settled for it (`docs/evals/judge-cases-*.json`): how a judge is measured before use. | |
| observation | One small dated reading of a moment, with a quote checked against its source: a model's reading, not a verified fact. Id `obs_…`. | |
| type | What an observation is: `to_do`, `promise`, `waiting_on_someone`, `choice`, `about_a_person`, `preference`, `idea`, `news`, `nothing` (SCHEMA.md, "Words used below"). | |
| modality | How an observation holds: `fact`, `plan`, `reported`, `conditional`. | |
| importance | How much something matters to the owner: a unit's or an observation's 0–3, a moment's 1–3 (SCHEMA.md). | |
| page | A person's or an area's page, written from their observations. | |
| area, project | A part of the owner's life or work, and a project inside one, from `truth/`. | |
| truth | `truth/`: the owner's own files (people, areas, projects, goals). Only he writes them. | |
| correction | The owner's fix to the memory (`corrections.jsonl`). | |
| decision (his) | A question one of his loops puts to him, and his answer (`decisions.jsonl`, `/me/decisions`): Life acts on one only to send the reply he chose (`send`); the loop that asked acts on the rest. | card |
| label | The owner saying something matters or doesn't (`labels.jsonl`). | |
| fact check | A doubtful claim Life asks the owner about (`doubtful`), answered right, partly or wrong with his why, on his fact-check loop's decisions: `statements.jsonl`, `ratings.jsonl`, and the eval's `scores.jsonl` (`EvalScore`). Replaced the check page (`/check`) on 29 Oct 2026. | |
| doubt | Why a claim may be wrong, by a rule on what is stored (`doubtsOf`): `guessed-person`, `unsure-moment`, `low-confidence`. | |
| inferred | What Life guessed and uses until corrected: `people-inferred.jsonl` (`InferredPerson`, id `inf_…`), `repos-inferred.jsonl` (`InferredRepo`). | |
| closeness | How close a person is (`inner`, `regular`, `acquaintance`, `faded`), which decides who gets a page. | |

## Running

| Word | Means | Planned |
|---|---|---|
| Past calendar | The calendar Life writes every moment that happened to, one event each (the `past` setting). Life's output, never a source. | |
| sweep | A scheduled batch of steps: `nightly`, `midday`, `backfill`. | |
| run | One step's run inside a sweep, logged with its counts. | |
| run (a loop's) | One headless run of one of his loops, by life-loops' run id; a decision line's `run` names the one that wrote it. | session |
| watcher | The always-on service: every minute it folds in lifelog, hears asks, delivers them and syncs the board. | |
| tick | The watcher's minute. Only that. | |
| status | Whether Life works and how fresh it is. | |
| status snapshot | Every part of Life as a card, what the app's status window and menu-bar panel show (`host/status/snapshot.ts`, the local `/status/snapshot`). | |
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
| time zone | Where the owner was, for local days (`zones.jsonl`, `zones.ts`): a recorded line's at that instant (`zoneAt`), the present's the latest noticed (`zoneNow`); where he is now is the phone's latest zone, else the Mac's (`readZoneHere`). | |
| boundary zone | One layer of the code in fallow's checks (`.fallowrc.json`). | |

Next: the [architecture](architecture.md) and [every record](SCHEMA.md).
