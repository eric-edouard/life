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
| split group | Clean sampled turns separated from a job's speaker label by voice; recognized turn rows keep the group, which supplies no identity or evidence. | |
| recheck | A voice the owner named as a person that lifelog, judging without that voice's own conversations, hears as another person on at least half of its sampled turns. Offered once more in the naming flow; his next answer for that voice (the same name or another) settles it for good. | |
| sample | A voice embedding of one clean recorded turn, with its model and revision; no extra audio. Unnamed samples are nobody's evidence. | |
| profile | A person's owner-attributed voice evidence, represented by one exemplar per conversation of clean clips. | |
| likeness | A voice's mean cosine to a person's closest profile exemplars; a score, not an identity or evidence. | |
| bench answer | What the owner says of a turn in the voice bench's review (one answer there names every turn of a voice's card): a person, nobody he knows, several people, not a person, or a skip. Several people and not a person leave the scoring. Kept in the bench's own file until `bench apply` sends it to lifelog's server as his correction. | |
| sender | Who wrote a message in a chat or mail. | |
| detail | A field about someone that his map or his Contacts already holds (birthday, where they live, work, family, handles), shown on their page (`memory/details.ts`). Never stored apart from where it lives; anything else about them is a page line. | |

## The agent's work

| Word | Means | Planned |
|---|---|---|
| ask | The owner's words handed to the agent: from "hey &lt;agent&gt;" in a recording, or a Claude session. A ledger entry of kind `ask`; the agent pulls its own with `read_agent_asks`. | |
| onAsk | An agent's own command, in its settings, that Life starts once per new ask so the agent pulls at once. It carries no words: the agent still reads its asks with `read_agent_asks`. Not a run (a step's run). | |
| event | MCP's word (its Events extension, `events.ts`): what an agent waits for, `message.received` today, polled with the agent's own filter and cursor (`events/poll`). Computed when polled, never stored. Not `SourceEvent`, a source's record in code, nor a calendar's event (the Past calendar's, an appointment's: the calendar's own word, in `google-calendar.ts`, `calendar-events.ts`, `appointment-events.jsonl`). | |
| mark | His words to Life, to keep: a promise that the unit is always read and every fact extracted, each at its own importance, not a claim that it matters (`marked` on the unit). Made by "hey Life" in a recording (Life's own wake, `LIFE_WAKE`; no ask), a message to himself, or `tell_life`. | |
| told, `tell_life` | What he tells Life in a chat: the connector's tool appends his words verbatim to `memory/told.jsonl`, read back as the source `told` ("Told Life"). Refused for an agent's token. | |
| bridge | A program that links one of his messaging accounts to his local Matrix homeserver, so Life can read LINE, Instagram and LinkedIn (`bun life bridge`, `NETWORKS`, docs/use/bridges.md). A network with no bridge on the Mac is copied from Beeper Desktop when Beeper holds it (`copierOf`). Not the connector (the MCP server). | |
| Beeper | Beeper Desktop, his messaging app: Life copies a network from its store (`copyBeeper`) when that network has no bridge on the Mac (LINE allows one session, and he keeps LINE in Beeper, 6 Nov 2026). Never its API or MCP: only its store keeps what a deletion blanks long enough for the archive's copy. | |
| grant | The owner's standing permission for Life to add his clear to-dos to his to-do list. | |

## The ledger and the to-do list

| Word | Means | Planned |
|---|---|---|
| ledger | `memory/ledger.jsonl`: every line where something crossed Life's boundary: the owner's asks and grants, Life's changes to his to-do list. Append-only. | |
| ledger entry | One line of the ledger (`LedgerEntry`, id `entry_…`). Its `via` says through what it came: a session, the connector, the watcher, the to-do list. | |
| to-do list | Where Life acts: the owner's Apple Reminders or Google Tasks, one per install (the `todo_list` setting, `TodoListBackend`, `todo-list/`). | |
| to-do item | One entry in the to-do list (`TodoItem`). | |
| act | The one command that decides and makes a change to a to-do item, and logs it in the ledger. | |
| open item | Anything owed, derived, never stored (`openItems`): a to-do, a promise, a reply owed, a to-do item, someone the owner is waiting on. A person's page lists those with them (`openWithOf`). | |

## Sources

| Word | Means | Planned |
|---|---|---|
| source | Where Life reads from, named after the app or service: `lifelog`, `whatsapp`, `imessage`, `phone`, `line`, `instagram`, `linkedin`, `telegram`, `mail`, `notes`, `git`, `screen` (Screen Time), `apple-health`, `claude`, `chatgpt`, and the agent's. | |
| kind | What a source is to the memory: `voice`, `chat`, `mail`, `own_writing` (the owner's own words: Apple Notes, his imported assistant chats), `repo`, `screen`, `physical`, `agent`. | |
| activity | What his devices record he did, never anyone's words: the `repo`, `screen` and `physical` kinds (`isActivity`). Never extracted, importance 1 at most. | |
| stint | One stretch of time in one app or website on one device, from Screen Time; the same one back within 2 minutes is one stint. Not a Claude session. | |
| device-day | A Screen Time unit: one device's stints on one local day, its time by app and website and its stints of 5 minutes or more. The device is named by the `devices` setting. | |
| apple-health | The Apple Health source, read through lifelog's REST contract into a derived copy. Off until enabled in `sources`. | |
| measurement | One Apple Health record: a sleep segment, an hour's steps, a workout, resting heart rate, heart rate variability or weight. Instants only. | |
| physical | The source kind for what devices measure of the owner's body; an activity kind. | |
| measurement-day | One local day's Apple Health measurements; a sleep counts on its wake day. | |
| Voice | The voice source as the owner sees it: his recordings, through lifelog. | the app's card, Pendant today |
| conversation | What lifelog groups the owner's speech into, by rules: Life's voice units come from its turns. | |
| turn | One speaker's stretch of a recording, cited `<job>:<turn>@<start>`. | |
| conversation-day | A voice unit: one conversation's turns on one local day, its words fetched only when its day is read. | |
| chapter | One of lifelog's summarized stretches of a conversation. A stored unit that is one (it carries lifelog's summary) is kept as stored, never built again, and its conversation gets no conversation-days. | |
| transaction | A mail Mail itself sorted as Transactions (an order, booking, receipt, delivery or bank notice), kept even from a sender he doesn't know. Not a database transaction. | |
| phone source | Phone & FaceTime call history (`phone`), copied from Apple’s store into `archive/phone.sqlite`; call-only chats keyed by remote handles or explicit participant sets; the Phone app's call log, not the owner's iPhone recordings (lifelog's `phone`). | |
| phone call | A voice or video call, on Phone & FaceTime or a messaging app: one event of its chat (including a call-only chat), with its length once it ended (0: not picked up), its line written by Life (`callLine`). "Call" alone is a model call. | |
| heard as | How lifelog heard a voice it could not name (`readVoiceKinds`): live with him, live nearby but not talking with him, over a phone, from a screen or speaker, an announcement. Its words carry it as a prefix. | |
| payment | Money he paid or got back, as his money app gives it (`apps/server/src/payments/`): not a source, never a unit nor read by a model. Placed at read time in his day, the episode it happened in (the shortest holding its time) and where he was. Not a `transaction` (a mail). | |
| paid | What was paid in an episode or a range, in EUR: money out less refunds. Not "cost" or "spend", which are model spend (`run-log.ts`). | |
| archive | Life's own copy of the WhatsApp, the bridged networks' and Notes stores, the only live copy of deleted messages and old note versions. | |

## The memory

| Word | Means | Planned |
|---|---|---|
| unit | The smallest piece Life reads: a conversation-day (or a stored chapter), a chat's day, a mail thread's day, a note's day, a repo's day, a device-day, a measurement-day. Id `unit_…`. | |
| verdict | A unit's judgement: its type, importance and area, with the reason. Only that. | |
| episode | A stretch of the owner's day that happened, read from the day's units and stays together; never a plan. Called moment before Nov 2026. Id `ep_…`. | |
| part | The new units of a day that fit one call, in time order (`dayPartOf`); a day too long for one call is read in parts, each seeing the episodes the one before wrote. | |
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
| importance | How much something matters to the owner: a unit's or an observation's 0–3, an episode's 1–3 (SCHEMA.md). Its thresholds, by name only (`records/unit.ts`): `SEARCHABLE_AT` (1, a searchable line), `KEEP_AT` (2, kept and shown), `TOP_AT` (3, what must not be missed). | |
| page | A person's or an area's page, written from their observations. | |
| situation | Where things stand now with him or someone close (how he is, together or not, how they get along), read nightly from the last 30 days' episodes, the page and the persona (what repeats); not a page section, not a fact (`memory/situations/`). | |
| area, project | A part of the owner's life or work, and a project inside one, from `truth/`. A project is underway while active or waiting (`isUnderway`); parked or done, it is not. | |
| truth | `truth/`: the owner's own files (people, areas, projects, goals). Only he writes them. | |
| correction | The owner's fix to the memory (`corrections.jsonl`). | |
| label | The owner saying something matters or doesn't (`labels.jsonl`). | |
| fact check | A doubtful claim Life asks the owner about (`doubtful`), answered right, partly or wrong with his why, in a chat: the connector's `read_fact_checks` lists the open ones, `correct_memory` (`fact_check`) records the answer. `statements.jsonl`, `ratings.jsonl`, and the eval's `scores.jsonl` (`EvalScore`). | |
| doubt | Why a claim may be wrong, by a rule on what is stored (`doubtsOf`): `guessed-person`, `low-confidence`. | |
| fold | One person ref read as another (`foldsOf`'s `canon`): his `same-person`, and every inferred id a surface was given read as what the surface reads as now. | |
| inferred | What Life guessed and uses until corrected: `people-inferred.jsonl` (`InferredPerson`, id `inf_…`; `person` when it is someone in `truth/`, then read as them), `repos-inferred.jsonl` (`InferredRepo`). | |
| persona | What someone with a page is like, wants and can give, what keeps happening between them and him, and how each writes to the other (his own: across everyone); read weekly from 3 years of their messages, group chats and his recordings with them (his own also from his own writing); its lines' `facet`: `traits`, `wants`, `offers`, `balance` (whether what goes each way, in Foa's six resources, evens out), `reacts`, `pattern`, `approach`, `writes`. Not a page, not facts, not the situation (the present), never a diagnosis (`memory/personas/`). | communication style (its `writes` lines; the connector still says "Communication style") |
| gist | A persona's 2 or 3 sentences, from the same call as its lines: what they are like, what keeps happening between them and him, what works with them; shown first. Not the page's who they are to him. | |
| support | How well a persona line is backed, counted when read from its quotes' days (`supportOf`): `solid` (3 days or more), `thin`, `old` (newest quote over a year old). Never stored. | |
| closeness | How close a person is (`inner`, `regular`, `acquaintance`, `faded`), which decides who gets a page. | |
| map | Everyone and every project a model reply may name: the people of `truth/` and those Life inferred (not folded into another), and his projects (`refContext`'s `map`). A call's context shows only part of it. | |
| involved | The map entries a model call involves that its context leaves out, given in its input (`involvedOf`). Everyone not close now (once close, not yet judged, inferred) and every project not underway reaches a model only this way. | |

## Running

| Word | Means | Planned |
|---|---|---|
| appointment | Something he is due at, read nightly from the facts ahead of him (plans, bookings) across every channel: a time, a place, a title, kept in his calendar until it is past (`memory/appointments.json`, id `apt_…`). Not a to-do, not an episode (what happened). | |
| Past calendar | The calendar Life writes every episode to, one event each (the `past` setting). Life's output, never a source. | |
| sweep | A scheduled batch of steps: `nightly`, `midday`, `backfill`. | |
| run | One step's run inside a sweep, logged with its counts. | |
| watcher | The always-on service: every minute it folds in lifelog, hears asks and syncs the to-do list. | |
| tick | The watcher's minute. Only that. | |
| online | Life can reach his model provider (`isOnline`). Offline, nothing scheduled runs or alerts. | |
| status | Whether Life works and how fresh it is. | |
| status snapshot | Every part of Life as a card, what the app's status window and menu-bar panel show (`host/status/snapshot.ts`, the local `/status/snapshot`). | |
| status reads | Life's read-only JSON about itself: the connector's `read_life_status`, `read_processing_runs`, `read_memory_changes` and `read_observation` (`docs/status-reads.md`), and the app's local `/status/*` (`host/http/status-reads.ts`). | |
| connector | Life's MCP server (`/mcp`), which ChatGPT and Claude call. Its tools say what they do: `read_…` reads, `correct_memory` and `change_todo_item` write; `read_agent_asks` is an agent's own feed of asks; `search` and `fetch` keep ChatGPT's names. | |
| exchange | One sitting of talk in a stream of messages, in time order, ended when nothing is written for 6 hours (`exchangesOf`, `EXCHANGE_ENDS_AFTER`, `memory/exchanges.ts`). The caller chooses the stream: one person's messages across channels (the persona's counts: who opened, how fast each answers) or one chat. Not a passage (search's text, cut by size and 30 minutes), not a conversation (lifelog's grouping of speech), not lifelog's `exchanges` (turns traded in a conversation); the episodes prompt calls it a burst. | |
| exchange batch | What one call reads when a stream's exchanges are read together: consecutive exchanges up to 30,000 characters, an exchange never cut (`batchesOf`, `EXCHANGE_BATCH_CHARS`, `memory/exchanges.ts`). Not the batches of calls a step runs side by side (`inBatches`). | |
| living chat | A chat or a mail thread both sides wrote in (`isLiving`, `memory/exchanges.ts`): the ones a read of exchanges is for. One only he or only they wrote in is not. | |
| move | Something one person did toward another in an exchange, as a read lists it: its code, the line it is on, the words that show it. Who made it and when come from the message, never from the model; a move whose words are not in its exchange is dropped. Read by the memory rework's pilot today (`scripts/memory-pilot.ts`), stored nowhere in `memory/` yet. Not a trait, not a verdict on a person; not the `act` command, not a mark (his words to Life). | |
| read (of exchanges) | One kind of pass a model makes over exchange batches, by its prompt: `connection` so far (`READS`, `scripts/memory-pilot.ts`). Not `readX`, a function that reads disk or the network. | |
| question case | One of the owner's questions about his life, as he asked it, with the points a right reply holds and those it must not say (`docs/evals/question-cases.json` in his data; `scripts/question-cases.ts`). Asked to a headless agent that has only the connector's reads, checked by the eval judge. Its id starts with the letter of its kind in his question set; `asker` says his own or mined from his chats. Not a regression case (an audit's, with no question), not a judge case, not a bench answer (the voice bench's). | |
| passage | What search reads as one text: a chat's consecutive messages, cut at 30 minutes of silence, 12 messages or 700 characters; a longer message or a note's version alone (`passagesOf`). Its first message's unit is its sole owner; source plus first-message id identifies it across day and month boundaries. Stored in a derived passage store, outside the search index. lifelog's search has its own, of a conversation's turns. | |
| router | A service that sends one API call to the host Life names: OpenRouter or allmodels.io (`ROUTERS`, `models/routers.ts`). Not an engine: an API engine may use several. | |
| route | One host an API engine asks, in order: a router, the model on it, the host (`routesOf`). | |
| embedder | The local model that turns a text into a vector for search by meaning (`core/embedder.ts`): EmbeddingGemma under llama.cpp, a Lifelog Host child. | |
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
