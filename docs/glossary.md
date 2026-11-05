# Glossary

Reference: every word Life uses for one of its concepts, with what it means. One word per concept, the same in the
docs, the app, the email, the connector and the code. A name that is not here is a plain English word.

**Word** is the name in code and stored data today. **Planned** is a decided rename that hasn't landed yet: until it
does, code and stored data use the Word, and the PR that lands it moves the new name into Word. Stored values and
their formats are in [SCHEMA.md](SCHEMA.md).

## People

| Word | Means | Planned |
|---|---|---|
| owner | The one person whose life Life holds. Stored as `person:me`. In the app and user docs, "you". | |
| agent | One of the owner's assistants that take his asks (a ChatGPT or Claude agent), known by its name: a key of the `agents` setting (`agentNames`), on its asks (`after.agent`) and its pairing. Nothing branches on a name. The word stored for an agent's source is `AGENT_WORD`, `agent`. | |
| pairing | How an app is approved on the connector: `bun life pair <agent>` prints a code; the app's grant (its tokens and refresh record) carries that agent's name as its agent claim, which is how the connector knows the agent (`authInfo.extra.agent`). A grant with no claim (a plain app, `bun life pair` alone) reads, but pulls no asks. | |
| speaker | Who said a turn in a recording. | |
| sender | Who wrote a message in a chat or mail. | |

## The agent's work

| Word | Means | Planned |
|---|---|---|
| ask | The owner's words handed to the agent: from "hey &lt;agent&gt;" in a recording, or a Claude session. A ledger entry of kind `ask`; the agent pulls its own with `read_agent_asks`. | |
| onAsk | An agent's own command, in its settings, that Life starts once per new ask so the agent pulls at once. It carries no words: the agent still reads its asks with `read_agent_asks`. Not a run (a step's run). | |
| mark | An ask's span in a recording, recorded by the hearing so its unit is read again at importance 3 (`marked` on the unit). Not a separate wake: "hey Life" is one of the agent's wake words. | |
| bridge | A program that links one of his messaging accounts to his local Matrix homeserver, so Life can read LINE, Instagram and LinkedIn (`bun life bridge`, `NETWORKS`, docs/use/bridges.md). Not the connector (the MCP server). | |
| grant | The owner's standing permission for Life to add his clear to-dos to his to-do list. | |

## The ledger and the to-do list

| Word | Means | Planned |
|---|---|---|
| ledger | `memory/ledger.jsonl`: every line where something crossed Life's boundary: the owner's asks and grants, Life's changes to his to-do list. Append-only. | |
| ledger entry | One line of the ledger (`LedgerEntry`, id `entry_…`). Its `via` says through what it came: a session, the connector, the watcher, the to-do list. | |
| to-do list | Where Life acts: the owner's Apple Reminders or Google Tasks, one per install (the `todo_list` setting, `TodoListBackend`, `todo-list/`). | |
| to-do item | One entry in the to-do list (`TodoItem`). | |
| act | The one command that decides and makes a change to a to-do item, and logs it in the ledger. | |
| open item | Anything owed, derived, never stored (`openItems`): a to-do, a promise, a reply owed, a to-do item, someone the owner is waiting on. | |

## Sources

| Word | Means | Planned |
|---|---|---|
| source | Where Life reads from, named after the app or service: `lifelog`, `whatsapp`, `imessage`, `line`, `instagram`, `linkedin`, `telegram`, `mail`, `notes`, `git`, `screen` (Screen Time), `claude`, `chatgpt`, and the agent's. | |
| kind | What a source is to the memory: `voice`, `chat`, `mail`, `own_writing` (the owner's own words: Apple Notes, his imported assistant chats), `repo`, `screen`, `agent`. | |
| activity | What his devices record he did, never anyone's words: the `repo` and `screen` kinds (`isActivity`). Never extracted, importance 1 at most. | |
| stint | One stretch of time in one app or website on one device, from Screen Time; the same one back within 2 minutes is one stint. Not a Claude session. | |
| device-day | A Screen Time unit: one device's stints on one local day, its time by app and website and its stints of 5 minutes or more. The device is named by the `devices` setting. | |
| Voice | The voice source as the owner sees it: his recordings, through lifelog. | the app's card, Pendant today |
| conversation | What lifelog groups the owner's speech into, by rules: Life's voice units come from its turns. | |
| turn | One speaker's stretch of a recording, cited `<job>:<turn>@<start>`. | |
| conversation-day | A voice unit: one conversation's turns on one local day, its words fetched only when its day is read. | |
| chapter | One of lifelog's summarized stretches of a conversation. A stored unit that is one (it carries lifelog's summary) is kept as stored, never built again, and its conversation gets no conversation-days. | |
| transaction | A mail Mail itself sorted as Transactions (an order, booking, receipt, delivery or bank notice), kept even from a sender he doesn't know. Not a database transaction. | |
| phone call | A voice or video call on a messaging app (WhatsApp, LINE, Instagram): one message of its chat, with its length once it ended (0: not picked up), its line written by Life (`callLine`). "Call" alone is a model call. | |
| heard as | How lifelog heard a voice it could not name (`readVoiceKinds`): live with him, live nearby but not talking with him, over a phone, from a screen or speaker, an announcement. Its words carry it as a prefix. | |
| archive | Life's own copy of the WhatsApp, the bridged networks' and Notes stores, the only live copy of deleted messages and old note versions. | |

## The memory

| Word | Means | Planned |
|---|---|---|
| unit | The smallest piece Life reads: a conversation-day (or a stored chapter), a chat's day, a mail thread's day, a note's day, a repo's day, a device-day. Id `unit_…`. | |
| verdict | A unit's judgement: its type, importance and area, with the reason. Only that. | |
| episode | A stretch of the owner's day that happened, read from the day's units and stays together; never a plan. Called moment before Nov 2026. Id `ep_…`. | |
| leftover | A unit a day's reading kept (importance 2+) that could make an episode but is in none; the second look, one more call with only those, places them (`leftoversOf`). | |
| what | An episode's own account: what happened and what came of it, in one to three sentences. Not a unit's `summary` (lifelog's, of one conversation). | |
| within | The episode holding another (a dinner within a trip). | |
| stay | One place his phone stayed, from lifelog's location history (`staysOf`); an episode's stay is the one covering most of it (`stayOf`), derived, never stored. | |
| truth set | Days he checked by hand (`docs/evals/truth-*.json` in his data: facts, timeline), what the bench grades against (`TruthSet`, `scripts/timeline.ts`). Not `truth/`, which only he writes. | |
| unkept | A unit Life read before that its latest verdict no longer keeps: its facts are replaced by none (`unkept` in extracted.jsonl). Not a dropped unit, which a code rule leaves out. | |
| kept both | A fact the memory both states and contradicts: a contradiction stored, counted apart from wrong by the eval and the bench. | |
| judge case | A fact with the claims a judge saw and the grade the owner settled for it (`docs/evals/judge-cases-*.json`): how a judge is measured before use. | |
| observation | One small dated reading of an episode, with a quote checked against its source: a model's reading, not a verified fact. Id `obs_…`. | |
| type | What an observation is: `to_do`, `promise`, `waiting_on_someone`, `choice`, `about_a_person`, `preference`, `idea`, `news`, `nothing` (SCHEMA.md, "Words used below"). | |
| modality | How an observation holds: `fact`, `plan`, `reported`, `conditional`. | |
| importance | How much something matters to the owner: a unit's or an observation's 0–3, an episode's 1–3 (SCHEMA.md). | |
| page | A person's or an area's page, written from their observations. | |
| situation | Where things stand now with him or someone close (how he is, together or not, how they get along), read nightly from the last 30 days' episodes and the page; not a page section, not a fact (`memory/situations/`). | |
| area, project | A part of the owner's life or work, and a project inside one, from `truth/`. A project is underway while active or waiting (`isUnderway`); parked or done, it is not. | |
| truth | `truth/`: the owner's own files (people, areas, projects, goals). Only he writes them. | |
| correction | The owner's fix to the memory (`corrections.jsonl`). | |
| decision (his) | A fact check Life puts to him, and his answer (`decisions.jsonl`, `/decisions`). Older lines of his loops' decisions stay on disk and fold to nothing. | card |
| overview | The list of all his decisions on the decisions page: a sidebar from 900 px, a sheet from the top below. Not the nightly report. | |
| label | The owner saying something matters or doesn't (`labels.jsonl`). | |
| fact check | A doubtful claim Life asks the owner about (`doubtful`), answered right, partly or wrong with his why, on decisions Life asks itself (`memory/fact-checks.ts`; a loop's until 30 Oct 2026): `statements.jsonl`, `ratings.jsonl`, and the eval's `scores.jsonl` (`EvalScore`). Replaced the check page (`/check`) on 29 Oct 2026. | |
| doubt | Why a claim may be wrong, by a rule on what is stored (`doubtsOf`): `guessed-person`, `low-confidence`. | |
| fold | One person ref read as another (`foldsOf`'s `canon`): his `same-person`, and every inferred id a surface was given read as what the surface reads as now. | |
| inferred | What Life guessed and uses until corrected: `people-inferred.jsonl` (`InferredPerson`, id `inf_…`; `person` when it is someone in `truth/`, then read as them), `repos-inferred.jsonl` (`InferredRepo`). | |
| closeness | How close a person is (`inner`, `regular`, `acquaintance`, `faded`), which decides who gets a page. | |
| map | Everyone and every project a model reply may name: the people of `truth/` and those Life inferred (not folded into another), and his projects (`refContext`'s `map`). A call's context shows only part of it. | |
| involved | The map entries a model call involves that its context leaves out, given in its input (`involvedOf`). Everyone not close now (once close, not yet judged, inferred) and every project not underway reaches a model only this way. | |

## Running

| Word | Means | Planned |
|---|---|---|
| Past calendar | The calendar Life writes every episode to, one event each (the `past` setting). Life's output, never a source. | |
| sweep | A scheduled batch of steps: `nightly`, `midday`, `backfill`. | |
| run | One step's run inside a sweep, logged with its counts. | |
| watcher | The always-on service: every minute it folds in lifelog, hears asks and syncs the to-do list. | |
| tick | The watcher's minute. Only that. | |
| status | Whether Life works and how fresh it is. | |
| status snapshot | Every part of Life as a card, what the app's status window and menu-bar panel show (`host/status/snapshot.ts`, the local `/status/snapshot`). | |
| status reads | Life's read-only JSON about itself: the connector's `read_life_status`, `read_processing_runs`, `read_memory_changes` and `read_observation` (`docs/status-reads.md`), and the app's local `/status/*` (`host/http/status-reads.ts`). | |
| web app | Life's pages for him (`apps/web`, served at `/`), each behind his sign-in; not the Mac app (Life.app). | |
| connector | Life's MCP server (`/mcp`), which ChatGPT and Claude call. Its tools say what they do: `read_…` reads, `correct_memory` and `change_todo_item` write; `read_agent_asks` is an agent's own feed of asks; `search` and `fetch` keep ChatGPT's names. | |
| record | One of the zod schemas of what Life writes, in `apps/server/src/records/`, one file per record (`unit.ts`, `episode.ts`, `ledger-entry.ts`…). | |

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
