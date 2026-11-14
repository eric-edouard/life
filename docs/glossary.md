# Glossary

Reference: every name Life uses for one of its concepts, with what it means. One name per concept, the same in the
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
| not relevant | The owner's answer for a voice he won't name: maybe someone he knows, so that voice is not asked about again and is never a stranger's reference (status `not_relevant`). Not "Not anyone I know", which makes a stranger. | |
| recheck | A voice the owner named as a person that lifelog, judging without that voice's own conversations, hears as another person on at least half of its sampled turns. Offered once more in the naming flow; his next answer for that voice (the same name or another) settles it for good. | |
| sample | A voice embedding of one clean recorded turn, with its model and revision; no extra audio. Unnamed samples are nobody's evidence. | |
| profile | A person's owner-attributed voice evidence, represented by one exemplar per conversation of clean clips. | |
| likeness | A voice's mean cosine to a person's closest profile exemplars; a score, not an identity or evidence. | |
| bench answer | What the owner says of a turn in the voice bench's review (one answer there names every turn of a voice's card): a person, nobody he knows, several people, not a person, or a skip. Several people and not a person leave the scoring. Kept in the bench's own file until `bench apply` sends it to lifelog's server as his correction. | |
| sender | Who wrote a message in a chat or mail. | |
| detail | A field about someone that his directory or his Contacts already holds (birthday, where they live, work, family, handles), shown on their page (`memory/details.ts`). Never stored apart from where it lives; anything else about them is a page line. | |

## The agent's work

| Word | Means | Planned |
|---|---|---|
| ask | The owner's words handed to the agent: from "hey &lt;agent&gt;" in a recording, or a Claude session. A ledger entry of kind `ask`; the agent pulls its own with `read_agent_asks`. | |
| onAsk | An agent's own command, in its settings, that Life starts once per new ask so the agent pulls at once. It carries no words: the agent still reads its asks with `read_agent_asks`. Not a step run. | |
| event | MCP's word (its Events extension, `events.ts`): what an agent waits for, `message.received` today, polled with the agent's own filter and cursor (`events/poll`). Computed when polled, never stored. Not `SourceEvent`, a source's record in code, nor a calendar's event (the Past calendar's, an appointment's: the calendar's own word, in `google-calendar.ts`, `calendar-events.ts`, `appointment-events.jsonl`). | |
| mark | His words to Life, to keep: a promise that the unit is always read and every fact extracted, each at its own importance, not a statement that it matters (`marked` on the unit). Made by "hey Life" in a recording (Life's own wake, `LIFE_WAKE`; no ask), a message to himself, or `tell_life`. | |
| told-life, `tell_life` | What he tells Life in a chat: the connector's tool appends his words verbatim to `memory/told-life.jsonl`, read back as the source `told-life` ("Told Life"). Refused for an agent's token. | |
| bridge | A program that links one of his messaging accounts to his local Matrix homeserver, so Life can read LINE, Instagram, Messenger and LinkedIn (`bun life bridge`, `NETWORKS`, docs/use/bridges.md). A network with no bridge on the Mac is copied from Beeper Desktop when Beeper holds it (`copierOf`). Not the connector (the MCP server). | |
| Beeper | Beeper Desktop, his messaging app: Life copies a network from its store (`copyBeeper`) when that network has no bridge on the Mac (LINE allows one session, and he keeps LINE in Beeper, 6 Nov 2026). Never its API or MCP: only its store keeps what a deletion blanks long enough for the archive's copy. | |
| auto-add permission | The owner's standing permission for Life to add the to-dos he says aloud to his to-do list (`setAutoAdd`; its ledger lines are stored as `grant` until the stored names change). | |

## The ledger and the to-do list

| Word | Means | Planned |
|---|---|---|
| ledger | `memory/ledger.jsonl`: every line where something crossed Life's boundary: the owner's asks and auto-add permission, Life's changes to his to-do list. Append-only. | |
| ledger entry | One line of the ledger (`LedgerEntry`, id `entry_…`). Its `via` says through what it came: a session, the connector, the watcher, the to-do list. | |
| to-do list | Where Life acts: the owner's Apple Reminders or Google Tasks, one per install (the `todoList` setting, `TodoListBackend`, `todo-list/`). | |
| to-do item | One entry in the to-do list (`TodoItem`). | |
| change-todo-item | The one command (`bun life change-todo-item`, `changeTodoItem`) that decides and makes a change to a to-do item, and logs it in the ledger. | |

## Sources

| Word | Means | Planned |
|---|---|---|
| coverage | Whether a source that captures on its own (a chat archive, mail, the pendant: `capturesOnItsOwn`) was captured on a local day: `captured` (it has a unit that day, or a publication of units read it for that day; the pendant with no unit: a recorded day; today, a readable source), `not seen` (before its first day, a day Life never read, a source a publication skipped, unreadable today, the pendant recording nothing) or `unknown` (before Life kept the record; the pendant before lifelog can tell, from the day it was last asked on, or never asked). Not silence: a quiet day is a captured day with nothing in it. A source that records only when he acts (photos, workouts, commits, notes) covers nothing (`memory/coverage.ts`, `memory/publications.jsonl`). `read_day` shows a day's; the person read counts, by month, the days a source of theirs was not seen or unknown (`notCapturedOf`). | |
| recorded days | The local days the pendant recorded on, with or without speech, as lifelog says (its `GET /recorded`): coverage's evidence for a pendant day Life holds nothing of. Derived: the night asks lifelog for all of it and rewrites `LIFE_STATE_DIR/memory/recorded-days.json` whole, so no read asks lifelog (`memory/recorded-days.ts`). | |
| source | Where Life reads from, named after the app or service: `lifelog`, `whatsapp`, `imessage`, `phone`, `line`, `instagram`, `messenger`, `linkedin`, `telegram`, `mail`, `notes`, `git`, `screen` (Screen Time), `apple-health`, `photos`, `claude`, `chatgpt`, and the agent's. | |
| kind | What a source is to the memory: `voice`, `chat`, `mail`, `own_writing` (the owner's own words: Apple Notes, his imported assistant chats), `repo`, `screen`, `physical`, `photos`, `agent`. | |
| activity | What his devices record he did, never someone else's words (a photo's caption is his): the `repo`, `screen`, `physical` and `photos` kinds (`isActivity`). Never extracted, importance 1 at most; physical and photos units can make episodes. | |
| stint | One stretch of time in one app or website on one device, from Screen Time; the same one back within 2 minutes is one stint. Not a Claude session. | |
| device-day | A Screen Time unit: one device's stints on one local day, its time by app and website and its stints of 5 minutes or more. The device is named by the `deviceNames` setting. | |
| apple-health | The Apple Health source, read through lifelog's REST contract into a derived copy. Off until enabled in `sources`. | |
| measurement | One Apple Health record: a sleep segment or a workout. Instants only; a night (its segments together) and a workout each make an episode, never extracted facts. | |
| physical | The source kind for what devices measure of the owner's body; an activity kind. | |
| measurement-day | One local day's Apple Health nights and workouts, each as a timed span; a night belongs to the day it began. | |
| photos | The Photos library as a source, read in place and read-only. Off until enabled in `sources`. | |
| ocr | The words Apple found in a photo (signs, screenshots of text), as a set in no text order, from its search index. Not a transcript. | |
| photo-day | A Photos unit: one local day of his library, its photos grouped by half hour and place, each line with Apple's place, scenes, who is pictured and his captions. Never an image. | |
| pictured | Who Apple's People names on a photo's faces, by name and, when Apple links a Contacts card, its handle. Not a unit's `people` (refs). | |
| scene | A label Apple's photo analysis gives a photo (beach, sunset), from its search index. Not a topic (a verdict's tag). | |
| description | Life's reading of an image, in a sentence or two: a photo's (`sources/photo-descriptions.ts`), written on the Mac by the describer, or a message file's (`description` in `files.jsonl`, written by his provider's fast model, shown as "described by Life"). One concept in two stores. Not a caption (his), not an episode's `what`. | |
| describer | The local model that writes a photo's description (`models/describer.ts`): Qwen3.5-9B under llama.cpp, started by the watcher only while photos wait. Not the embedder, not Lifelog Host's children. | |
| Voice | The voice source as the owner sees it: his recordings, through lifelog. | the app's card, Pendant today |
| conversation | What lifelog groups the owner's speech into, by rules: Life's voice units come from its turns. | |
| turn | One speaker's stretch of a recording, cited `<job>:<turn>@<start>`. | |
| conversation-day | A voice unit: one conversation's turns on one local day, its words fetched only when its day is read. | |
| chapter | One of lifelog's summarized stretches of a conversation. A stored unit that is one (it carries lifelog's summary) is kept as stored, never built again, and its conversation gets no conversation-days. | |
| hasOwnerWrittenInThread | A mail event's flag: the owner wrote in its thread on any day (the source reads it over the whole index). Kept beside `fromMe`, which is the event's own sender. | |
| transaction | A mail Mail itself sorted as Transactions (an order, booking, receipt, delivery or bank notice), kept even from a sender he doesn't know. Not a database transaction. | |
| phone source | Phone & FaceTime call history (`phone`), copied from Apple’s store into `archive/phone.sqlite`; call-only chats keyed by remote handles or explicit participant sets; the Phone app's call log, not the owner's iPhone recordings (lifelog's `phone`). | |
| phone call | A voice or video call, on Phone & FaceTime or a messaging app: one event of its chat (including a call-only chat), with its length once it ended (0: not picked up), its line written by Life (`callLine`). "Call" alone is a model call. | |
| heard as | How lifelog heard a voice it could not name (`readVoiceKinds`): live with him, live nearby but not talking with him, over a phone, from a screen or speaker, an announcement. Its words carry it as a prefix. | |
| payment | Money he paid or got back, as his money app gives it (`apps/server/src/payments/`): not a source, never a unit nor read by a model. Placed at read time in his day, the episode it happened in (the shortest holding its time) and where he was. Not a `transaction` (a mail). | |
| paid | What was paid in an episode or a range, in EUR: money out less refunds. Not "cost" or "spend", which are model spend (`run-log.ts`). | |
| export row | A message an export's import wrote into a chat archive (Instagram's own export, `bun life import`), its `eventId` `export:<its millisecond>`: read like any message whatever the cutover, never an arrival (`EXPORT_ROW`, `sources/archived.ts`). Not an export copy: nothing of the export is kept but these rows and the files they name. | |
| export copy | An assistant export (claude.ai or ChatGPT) Life keeps as it came in `imports/<source>/`, one per import of different bytes, never replaced or merged. Not a Life export, not the archive. | |
| archive | Life's own copy of the WhatsApp, the bridged networks' and Notes stores, the only live copy of deleted messages and old note versions. | |

## The memory

| Word | Means | Planned |
|---|---|---|
| unit | The smallest piece Life reads: a conversation-day (or a stored chapter), a chat's day, a mail thread's day, a note's day, a repo's day, a device-day, a measurement-day. Id `unit_…`. | |
| verdict | A unit's judgement: its type, importance and area, with the reason. Only that. | |
| episode | A stretch of the owner's day that happened, read from the day's units and stays together; never a plan. Called moment before Nov 2026. Id `ep_…`. | |
| day part | The new units of a day that fit one call, in time order (`dayPartOf`); a day too long for one call is read in parts, each seeing the episodes the one before wrote. | |
| history month part | One piece of a history month's reading: its summary and the quotes that back it (`HistoryPart`, `memory/histories.ts`). Not a day part, not a read part. | |
| subject | What a read is about: a person, project or area (a `SubjectRef`: `person:<id>`, `project:<id>`, `area:<id>`). | |
| read part | One bounded piece of what Life holds about a subject, about `PART_CHARS` characters, opened by its ref and ending with its next reads (`memory/read-part.ts`); today a person's `now` (who and where things stand), `page`, `persona`, `story` (the years), `year` (its months' summaries), `month` (its words and days) and `evidence` (observations, episodes and recorded conversations, by span, paged back). Not a day part, not a history month part. | |
| read part ref | A read part's id, `<subject>/<part>[/<span>][/before/<day>]` (`person:ana/evidence/2024-03`; a span is a year, YYYY, or a month, YYYY-MM), opened by `fetch` (`openById`) and `person --part`; worked out, never stored (`ReadPartRef`, `parseReadPartRef`, `readPartRefOf`). | |
| next reads | The last lines of a read part: the refs of its deeper reads, each with what it holds (`nextReads`). | |
| what | An episode's own account: what happened and what came of it, in one to three sentences. Not a unit's `summary` (lifelog's, of one conversation). | |
| within | The episode holding another (a dinner within a trip). | |
| stay | One place his phone stayed, from lifelog's location history (`staysOf`); an episode's stay is the one covering most of it (`stayOf`), derived, never stored. | |
| truth set | Days he checked by hand (`docs/evals/truth-*.json` in his data: facts, timeline), what the bench grades against (`TruthSet`, `scripts/timeline.ts`). Not `truth/`, which only he writes. | |
| unkept | A unit Life read before that its latest verdict no longer keeps: its facts are replaced by none (`unkept` in extracted.jsonl). Not a dropped unit, which a code rule leaves out. | |
| kept both | A fact the memory both states and contradicts: a contradiction stored, counted apart from wrong by the eval and the bench. | |
| judge case | A fact with the memory lines a judge saw and the grade the owner settled for it (`docs/evals/judge-cases-*.json`): how a judge is measured before use. | |
| observation | One small dated reading of an episode, with a quote checked against its source: a model's reading, not a verified fact. Id `obs_…`. | |
| type | What an observation is: `to_do`, `promise`, `waiting_on_someone`, `choice`, `about_a_person`, `preference`, `idea`, `news`, `nothing` (SCHEMA.md, "Words used below"). | |
| modality | How an observation holds: `fact`, `plan`, `reported`, `conditional`. | |
| importance | How much something matters to the owner: a unit's or an observation's 0–3, an episode's 1–3 (SCHEMA.md). Its thresholds, by name only (`records/unit.ts`): `SEARCHABLE_AT` (1, a searchable line), `KEEP_AT` (2, kept and shown), `TOP_AT` (3, what must not be missed). | |
| page | A person's or an area's page, written from their observations. | |
| situation | Where things stand now with him or someone close (how he is, together or not, how they get along), read nightly from the 30 days of episodes ending at their newest, the page and the persona (what repeats); not a page section, not a fact (`memory/situations/`). | |
| area, project | A part of the owner's life or work, and a project inside one, from `truth/`. A project is underway while active or waiting (`isUnderway`); parked or done, it is not. | |
| truth | `truth/`: the owner's own files (people, areas, projects, goals). Only he writes them. | |
| correction | The owner's fix to the memory (`corrections.jsonl`). | |
| importance label | The owner saying a unit is important or isn't, with the right type and area when he gives them (`labels.jsonl`, `important`). | |
| fact check | The stored record of a check he answered (a `FactCheck`, frozen as he was shown it, written just before his answer, never drawn ahead), and the answer to it (a `FactCheckAnswer`, `correct_memory` `fact_check`). Today only an ending check (`endedBy` set; its text is the check's guess, "Life thinks this is done: ...", earlier lines "Done? ...") is written so: the connector's `read_fact_checks` lists the open ones (`readEndingChecks`, from `checksNow`); right is his `outdated` word on the open step, wrong removes the link between those two ids. Lines drawn before 14 Nov 2026 and never answered stay in the file and are not open. `fact-checks.jsonl`, `fact-check-answers.jsonl`, and the eval's `scores.jsonl` (`EvalScore`). | |
| memory line | An observation or an episode in the words he is shown and the eval judge reads (`MemoryLine`, `memoryLinesNow`, `memory/doubts.ts`). | |
| doubt | Why a memory line may be wrong, by a rule on what is stored (`doubtsOf`): `guessed-person`, `low-confidence`. | |
| fold | One person ref read as another (`foldsOf`'s `canon`): his `same-person`, and every inferred id a name or handle was given read as what it reads as now. | |
| check | One guess of Life's that his word would settle, shown with its evidence (a quote, where and when): a `Check` of `memory/checks.ts`, worked out when read (`checksNow`, `bun life memory checks`), never stored, with no limit. It exists only while something rides on the guess; Life keeps using the guess meanwhile. Not a fact check (a line he is asked about, frozen as shown). | |
| check kind | What a check is about: `ending` (a link says an open step is done), `person` (who someone is: a guess, a card or a name). Each is one entry of `BUILDERS`; a line with a doubt of its own would be a third. | |
| rides on | What uses a guess, counted from what is stored: the kept lines, the open matters and the pages (`ridesOn`). A check exists only when a kept line or an open matter rides on it; it is also how checks are ordered. | |
| person check | A check about who someone is: a guessed person, a Contacts card Life cannot place (an ambiguous card) or a name it cannot place. His word is a `this-is`, `not-this-person` or `same-person` correction. | |
| guess | An inferred person his word has not named (`isGuess`, `guessedOf`). A line resting on one has the `guessed-person` doubt; it is settled by one answer on the person, not line by line. | |
| contact person | Someone his Contacts name whose handle appears in his messages: a line of `memory/people-contacts.jsonl`, id `con_…` from the card's own id, read below `truth/` and above a guess. Not inferred: no model said it, and a card of someone in `truth/` is that person, by its whole name, a shared handle, or their first name and birthday. An **ambiguous card** is one whose whole name, handles and birthday say more than one person (a card he renamed, two people in one card, a number two people share): Life places it under no one and `bun life memory checks` lists it for him (`memory/contact-people.ts`, `who.ts` `foldsOf`). | |
| inferred | What Life guessed and uses until corrected: `people-inferred.jsonl` (`InferredPerson`, id `inf_…`; `person` when it is someone in `truth/`, then read as them), `repos-inferred.jsonl` (`InferredRepo`). | |
| link | Two records tied by the links step, inside one matter since v2 (v1 links could tie observations now in two): today only `ends` (a later step of the matter, an observation or an episode, shows that an open step of it, a promise, a wait or a to-do of his, happened or was dropped), with the words of the later one that show it (`memory/links.jsonl`, `memory/links.ts`). Not a summary, not a new claim, never a deletion: what it ends is worked out when read, and until his word (a fact-check answer, right, which is an `outdated` correction) the matter shows "maybe done" and stays open; wrong removes the link between those two ids for good (`memory/endings.ts`). Not a to-do item's `link` (its id in his list), not a bridge linking an account, not who an observation is about (`observation_entities`). | |
| matter | One running thing in his life that he never declared as a project and that takes several days or weeks (an errand for someone, a purchase, a repair, a dispute, an application, a trip being arranged), with something to be done or awaited. Found by the matters step from episodes (`memory/matters.jsonl`, `memory/matters.ts`, id `matter_…`). Not a topic, not a person, not a routine, not a declared project (a matter may belong to one). | |
| matter step | A record placed in a matter (`MatterStep`, stored as `steps`): a unit, an observation or a to-do item, with the quote that places it; an episode placed is stored as its units (a day's episodes are rewritten). A matter's timeline is its steps in time order (the episodes holding its units, observations at importance 2 or more and any placed one, to-do items, the ledger's lines on its observations). Not a processing step, which is one stage of a processing run. | |
| matter status | Where a matter stands, worked out when read, never stored (`matterOf`, `memory/matter-read.ts`): `done` (its newest to-do, promise or wait has an ending), else `stuck` (a date of an open step has passed, at any age), else `waiting_on_someone` (what is next is a wait), else `moving` (a step in the last 14 days), else `dormant` (still open: only an ending closes a matter). Silence alone is never stuck. A matter is open until then; a lone open observation or to-do item no matter holds is a matter of one. `read_matters` lists the running ones (open, not dormant); `read_matter`, `read_day`'s Due and a person's page all read it: the one rule of what is open. | open item (retired) |
| owed to, waiting on, with, told | A matter's people by role, from its steps (`matterOf`): `owed_to` is who asked him (a to-do that was not his own) or whom he promised; `waiting_on` the person of an open wait (named after the status `waiting_on_someone`); `with` and `told` the roles of the episodes' own people. | |
| ending | How an open thing closed: the link that ends it (`endingsOf`), or his word. Never inferred from silence or age: an item past its time is lapsed, which no record says. | |
| history | A person's past months with him, each summarised once from their one-to-one chats and mail (a closed month, read again only when what it was shown changes), and the story of the years told from those months (`memory/histories/`, `memory/histories.ts`); shown in the person read. Not the page's Earlier section (dated facts), not the situation (the present month), not the persona (what someone is like), not the historical collection (old units, `bun life memory historical-units`). | |
| persona | What someone with a page is like, wants and can give, what keeps happening between them and him, and how each writes to the other (his own: across everyone); read weekly from 3 years of their messages, group chats and his recordings with them (his own also from his own writing); its lines' `facet`: `traits`, `wants`, `offers`, `balance` (whether what goes each way, in Foa's six resources, evens out), `reacts`, `pattern`, `approach`, `writes`. Not a page, not facts, not the situation (the present), never a diagnosis (`memory/personas/`). | |
| gist | A persona's 2 or 3 sentences, from the same call as its lines: what they are like, what keeps happening between them and him, what works with them; shown first. Not the page's who they are to him. | |
| backing | How well a persona line is backed, counted when read from its quotes' days (`backingOf`): `solid` (3 days or more), `thin`, `old` (newest quote over a year old). Never stored. | |
| earlier | The page section holding what is over or too old for its section: dated lines, newest first (`SECTION` in `page-format.ts`; stored as `earlier`, a keep-mine correction's `section`). Not a person's history (past months, below). | |
| name as written | A name Life could not map to `truth/`, as a model or a chat wrote it (`nameAsWritten` in `unresolved.jsonl`). A name or handle that may be either is `nameOrHandle`; a person's known ones `namesAndHandles`; a Contacts card's phones and emails `handles`. | |
| observation status | Where an observation stands: `active`, `retired`, `replaced`, `gone` or `hidden` (`observationStatusOf`, `memory/memory-files.ts`; its inputs are `ObservationStatusInputs`). | |
| closeness | How close a person is (`inner`, `regular`, `acquaintance`, `faded`), which decides who gets a page. Its type is `ClosenessLevel`. | |
| directory | Everyone and every project, area and goal Life knows: the people of `truth/` and those Life inferred (not folded into another), and his projects, areas and goals; a model reply may name its people and projects (`refContext`'s `directory`). A call's context shows only part of it. | |
| involved | The directory entries a model call involves that its context leaves out, given in its input (`involvedOf`). Everyone not close now (once close, not yet judged, inferred) and every project not underway reaches a model only this way. | |

## Running

| Word | Means | Planned |
|---|---|---|
| appointment | Something he is due at, read nightly from the facts ahead of him (plans, bookings) across every channel: a time, a place, a title, kept in his calendar until it is past (`memory/appointments.json`, id `apt_…`). Not a to-do, not an episode (what happened). | |
| Past calendar | The calendar Life writes every episode to, one event each (the `pastCalendar` setting). Life's output, never a source. | |
| processing run | One scheduled batch of processing steps: `nightly`, `backfill` (`PROCESSING_RUNS`). | |
| processing step | One part of a processing run (`episodes`, `extract`, `pages`), shown as a step on the status card (`processingSteps`, tracked by `trackProcessingSteps`). Not a matter step. | |
| step run | One processing step's execution inside a processing run, in prose only; the run log records it as a logged run. | |
| logged run | A processing run, a step run or an eval, as the run log records it (`recordRun`, `RunRecorder`). | |
| watcher | The always-on service: every minute it folds in lifelog, hears asks and syncs the to-do list; every 5 minutes it builds today's units from the other sources, read raw until the night. | |
| tick | The watcher's minute. Only that. | |
| online | Life can reach his model provider (`isOnline`). Offline, nothing scheduled runs or alerts. | |
| status | Whether Life works and how fresh it is. | |
| status snapshot | Every part of Life as a card, what the app's status window and menu-bar panel show (`host/status/snapshot.ts`, the local `/status/snapshot`). | |
| status reads | Life's read-only JSON about itself: the connector's `read_life_status`, `read_processing_runs`, `read_memory_changes` and `read_observation` (`docs/status-reads.md`), and the app's local `/status/*` (`host/http/status-reads.ts`). | |
| connector | Life's MCP server (`/mcp`), which ChatGPT and Claude call. Its tools say what they do: `read_…` reads, `correct_memory` and `change_todo_item` write; `read_agent_asks` is an agent's own feed of asks; `search` and `fetch` keep ChatGPT's names. | |
| mention | One person someone not in the conversation talked about, as the mentions read lists it: who as the model wrote it, the quote, the message's line, the day's unit and who sent it, all as written (`mentionsOf`, `memory/mentions.ts`). Kept by the night in Life's state, never in `memory/`; it holds no person and no ref. Not a reading of who is meant (that is its placement), not an observation. | |
| mention placement | Who a mention means, worked out each time it is read: the person its whole `who` resolves to, when those words are on its line, else no one (`placementOf`, `memory/who.ts`). Its proof is how it was decided: `name`, or `relation_word` (his own relation word). Never stored, so a fold or a name given later moves it. Not a person's page, not an inferred person. | |
| relation word | A word for what a person is to someone ("father", "mon père"), from a small English and French list (`RELATION_WORDS`, `records/relation-words.ts`); each entry is one relation (dad and father are one) with its group; only the words that name one person by their nature (father, wife, girlfriend) place a mention. Not a name, not a person's directory text. | |
| talked about | The people an episode's units named without their being in it, worked out when read from its units' mentions and their placement (`talkedAboutOf`, `memory/mentions.ts`), shown by `read_day` only; never in the episode's memory line. Not "with" or "told". | |
| exchange counts | What code counts between him and one person over their one-to-one chats and mail threads, one row per exchange: who opened it, messages and deletions each way, minutes to each answer, its days (`memory/exchange-counts.ts`). Rebuilt whole from the sources each night into Life's state; folded over any span for the person read and the persona. Not a measurement (an Apple Health record), not a level (closeness), not a model's reading. | |
| exchange | One sitting of talk in a stream of messages, in time order, ended when nothing is written for 6 hours (`exchangesOf`, `EXCHANGE_ENDS_AFTER`, `memory/exchanges.ts`). The caller chooses the stream: one person's messages across channels (the exchange counts: who opened, how fast each answers) or one chat. Not a passage (search's text, cut by size and 30 minutes), not a conversation (lifelog's grouping of speech), not lifelog's `exchanges` (turns traded in a conversation); the episodes prompt calls it a burst. A read's exchange is named by its first message's key (`eventKey`, `records/source.ts`) within the chat it was cut from. | |
| exchange batch | What one call reads when a stream's exchanges are read together: consecutive exchanges up to 30,000 characters, an exchange never cut (`batchesOf`, `EXCHANGE_BATCH_CHARS`, `memory/exchanges.ts`). Not the batches of calls a step runs side by side (`inBatches`). | |
| finished exchange | An exchange nothing was written in for the 6 hours that end one (`isFinished`, `memory/exchanges.ts`): it can no longer grow, so a read may take it. The last exchange of a chat still going is not finished. Not a closed chat (none is marked). | |
| two-way chat | A chat or a mail thread both sides wrote in (`isTwoWay`, `memory/exchanges.ts`): the ones a read of exchanges is for. One only he or only they wrote in is not. | |
| move | Something one person did toward another in an exchange, as a read lists it: its code, the line it is on, the words that show it. Who made it and when come from the message, never from the model; a move whose words are not in its exchange is dropped. Checked by `checkedMoves`, shapes in `memory/moves.ts`; every checked move is kept. Never stored: what is stored is the read reply it comes from, and moves are worked out when read. Not a trait, not a verdict on a person; not a to-do item's list move (`listMoves`), not the `changeTodoItem` command, not a mark (his words to Life). | |
| read (of exchanges) | One kind of pass a model makes over exchange batches, by its prompt: `connection`, `mentions` and `conflict` (`MOVES`, `memory/moves.ts`; the prompts, `READS`, `memory/exchange-reads.ts`). Each lists its own codes, so a code is counted only over the exchanges its read saw. Not `readX`, a function that reads disk or the network. | |
| read reply | What a model answered when a read took some exchanges of a one-to-one chat, stored as given with what made it, the prompt digest and the keys of the messages it read (`ReadReply`, `records/read-reply.ts`; `memory/read-replies/`, a file for the month of its first message). An exchange is read by a read when a line of the read's current prompt lists it with exactly the messages it has now (`replyOf`). Not a move (worked out from a reply when read, never stored), not a fact-check answer. | |
| prompt digest | The digest of a prompt's text (16 hex), stored beside the prompt's versioned name in a read reply (`promptDigest`, `promptDigestOf`). Only the name decides whether an exchange is read again; the digest says what text made a reply. Not the prompt's version. | |
| exchange reads | The step that asks the three reads of the finished exchanges of his two-way one-to-one chats that have no stored reply, 200 calls a night, newest first, once his `exchangeReads` setting is on (`exchangeReads`, `memory/exchange-reads.ts`). Reading what is stored does not wait for the setting. Not the exchange counts (derived from the sources, no model). | |
| occurrence | The one count a code gets from one side in one exchange: the first move of that code by that side, and for a mention one per person talked about (`occurrencesOf`, `memory/move-rates.ts`). | |
| bid | A move that invites an answer: its shape holds `answer`, toward, away or against, or none (`BIDS`, `memory/moves.ts`). Spec 10's word; the exchange counts' "opened" is who wrote first. | |
| opportunity | What a move rate is a share of: `exchange` (the exchanges that side wrote in, which the code's read saw), `bid` (the bids the other side made), `fault` (exchanges where the other side raised a fault), `decision` (exchanges holding any steering code) (`OPPORTUNITY`, `memory/move-rates.ts`). | |
| move rate | `n` of `of` opportunities for one thing (a code, how a bid was met, warm tone, the tension and conflict flags) by one side, over all time, the 12 local months before a month the caller passes, and before that; per source for an exchange opportunity, never pooled (`moveRatesOf`, `memory/move-rates.ts`). Derived on each call, stored nowhere. Not the exchange counts (messages and waits), not a rating (a score he gives). | |
| seen exchange | An exchange as the reads saw it, merged by its first message's key: its moves, flags and tone, the sides that wrote in it (a call line is no one's writing) and the reads that listed it (`seenExchanges`, `SeenExchange`). | |
| exploratory | A thing counted but never said as a share, because it did not hold on the test set against the reference model: kappa 0.5 or more on 30 cases or more (`PROVEN`, `memory/move-rates.ts`). A new code is exploratory until proven. | |
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
| settled day | A day whose stored zone derived lines never change, so its units keep their dates and ids: a day a record cites by a unit id, one on or after the first episode, a deferred day that holds units, and one neighbour each side (`settledDays`, `historical-zones.ts`). | |
| travel day | A derived-era day whose own sent mail shows the zone changing between its known neighbours (it names both the zone of the known day before and of the one after, and they differ), a clock change included (2023-10-30, Europe's DST switch). Deferred, with no units, until a source can tell which part of the day was where (`historicalZonesOf`). | |
| derived era | The days before his first zone record that has no `source` (`derivedEraEnd`, `historical-zones.ts`): the only days photo offsets and sent-mail Date headers may set, defer or gap. | |
| boundary zone | One layer of the code in fallow's checks (`.fallowrc.json`). | |

Next: the [architecture](architecture.md) and [every record](SCHEMA.md).
