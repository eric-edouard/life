# Architecture

Explanation: how Life is built and why.

Life is a memory of one person's life, built from their own sources and kept on their own Mac. This page explains its
shape and the reasons for it. Record formats are in `docs/SCHEMA.md`, sources in `docs/sources.md`, the agent and the
connector in `docs/tasks.md`, how it runs in `docs/operations.md`.

## lifelog and Life

Life works beside lifelog, a companion project that captures voice. Each has one job:

| | lifelog | Life |
|---|---|---|
| Job | Voice capture: audio, transcripts, speakers, conversations, search | Memory across sources: voice (through lifelog), WhatsApp, LINE, Instagram, Messenger, LinkedIn, Telegram, iMessage, mail, Apple Notes, git, imported assistant chats |
| Owns | The raw spoken archive | The people across channels, observations, people and project pages |
| Runs | Its own host and the phone | The Mac (WhatsApp, Messages and Mail are Mac-only, and chats stay on the Mac) |
| Acts? | Never | Only on the owner's clear request (`docs/tasks.md`) |

- Life reads lifelog through its REST API with a device token (`apps/server/src/sources/lifelog.ts`): the change feed
  into a small store of who spoke when, never the words (except an ask's), and a turn's words, search and places on
  demand.
- Life builds its voice units from lifelog's conversations and their turns, by code; lifelog's summaries are never
  read. The chapter units already stored stay as they are: facts, his ratings and corrections cite them.
- Life writes to lifelog in two ways only: `forward`, the owner's explicit corrections (speaker, title, rename, merge),
  and `notifyPhone`, a "heard you" push for each voice ask (no words of his).
- Memory does not move into lifelog: memory about one person comes from voice, chats and mail together, and chats must
  not leave the Mac, nor their text go to a third party for embeddings. Life embeds its own texts with the embedder
  Lifelog Host runs, on loopback (`memory/vectors.ts`): the one call to lifelog's side outside its REST contract.

## The pipeline

```mermaid
flowchart LR
  subgraph Mac["The Mac"]
    direction LR
    S["Sources<br/>voice · chats · mail · notes · git"] --> U["Units<br/>a conversation-day, a chat-day, a thread-day"]
    U --> M["Episodes<br/>one read per day,<br/>a verdict per unit"]
    M --> O["Observations<br/>quote-checked facts"]
    O --> P["Pages<br/>people · areas · the owner"]
    O --> I[("Search index")]
    A[("Archive<br/>deleted messages,<br/>note versions")] --> S
    P --> C{{"Connector<br/>/mcp"}}
    I --> C
  end
  C <--> AI["Claude · ChatGPT"]
  AG["The agent"] -- "pulls its asks" --> C
```

- **Sources** (`apps/server/src/sources/`, one descriptor each in `apps/server/src/memory/sources.ts`) return records (`SourceEvent`) with stable ids, so reading
  twice never duplicates anything. Raw data stays in its own app.
- **Units** (`apps/server/src/memory/units.ts` only, through `gather`): a conversation-day, a chat-day, a mail thread-day, a
  note-day, a repo-day. Code drops obvious noise (one-time codes, newsletters, Life's own output, mail from no one he
  knows) before any model sees it.
- **Episodes** (`episodes.ts`): one deep model call per day reads the day from every channel in time order, with where
  his phone stayed: the units not judged yet in full, the rest as stubs, and the day's episodes as they stand. It writes
  a verdict per new unit (type, importance, area) and the episodes new, changed or gone: only what happened, each with
  `what` came of it and the episode holding it (`within`). The same call says who the day's unknown people are
  (`memory/people-inferred.jsonl`, used at once, corrected later); before it, the night names the senders his
  Contacts know (`memory/people-contacts.jsonl`, by code, read above any guess: `contact-people.ts`). A conversation-day's text is its words, fetched
  only for the units sent in full (`voiceText`). Nothing is cut (his request of 9 Nov 2026): a day too long for one
  call (`callCharsOf`, the provider's context) is read in parts, in time order, through the same re-read; a mail is
  its own words, the history it quotes left out (`ownWordsOf`). Apple Health and Photos units can make episodes: each workout
  and night has its own bounds, a photo-day its lines of photos at a place (with a local model's description of each photo, `models/describer.ts`; each photo is also a search passage). They remain activity (`isActivity`): never extracted, importance at most 1.
  Like other episodes, they become Past calendar events and memory claims; episodes are never asked as checks (nothing is drawn any more).
- **Observations** (`extract.ts`): extraction reads an episode's units together, with earlier facts shown as a reading to
  correct, never as evidence. Every quote is checked against its source (`quote-check.ts`). Extraction is the only step
  that retires an observation, besides the owner's word that one is outdated (a fact-check answer or an `outdated`
  correction).
- **Pages** (`page-format.ts` pure, `pages.ts` orchestration): the people and area pages, every line cited, no churn, 800
  words at most (the owner's own page 2,000).
- **Situations** (`situations.ts`): where things stand now with him and everyone with a page who has an episode in the last 30 days (`pagedNow`
  and `isRecent`: a client or a builder as much as a friend), read nightly by one call from the page, the persona (to say
  when the newest days repeat a known pattern or break it; only while the `personas` add-on is on) and the last 30
  days' episodes, each line citing episodes. The prompt (`memory-situation.v3`) is practical for anyone; how they get
  along, together or not, feelings and sex, and his own mood, love life and health are its parts for the `relationships`
  and `aboutMe` add-ons (prompt parts). Rebuilt whole when its inputs change (episodes, page digest, persona text while
  on, the prompt's variant name), so a new page or a toggled add-on refreshes it the next night,
  never from its own last version, so it stays a projection; older days fade into the page's sections and History,
  and git keeps every version. A reader shows a line only while its episodes are live and the situation was made by the variant the add-ons choose now (a toggle hides it at once), the situation first; a search also shows,
  from the situations it doesn't show whole, the lines citing an episode it found.
- **Communication styles** (`memory/communication-styles.ts`, `memory/communication-styles/`, core, no add-on; shown in the person read's `now`; his request of 16 Nov 2026: drafts in his voice for everyone with a page): one call per person with a page reads their newest 120 1:1 chat messages and 30 mails, both ways (the night's `readWithPeople`; Life's own output and the agent's reports left out, so drafts never learn from drafts), and writes how he writes to them and how they write to him, each point quoted from that writer's own chat messages and checked. Rebuilt whole per person at most weekly, when those messages changed; at most 200 calls a night, the newest first. Describes the writing, never the person.
- **Personas** (`personal/personas.ts`): a gist first (his request of 9 Nov 2026), then what each person with a page is like, what they want and can give (and what goes each
  way between them and him), what keeps happening between them (both sides, his part named), for an agent who reads them before he meets, calls or
  writes to them (how each writes is the communication style's, above); his own across everyone, with his own writing (his notes, his imported assistant
  chats; his request of 9 Nov 2026). One call per person reads what passed between them over
  3 years (his request of 8 Nov 2026: every raw source Life holds): their 1:1 messages both ways and the group
  chat-days they wrote in, his and their lines only (the night's read of chats and mail, `readWithPeople`, shared with
  closeness, which leaves groups out: a group is no measure of closeness, but it shows how someone is) and his
  recorded conversations where they spoke (the stored voice units, their words read only when the persona is due),
  every message whole: all of it when it fits one call (`callCharsOf`, his request of 9 Nov 2026: nothing cut), else
  sampled (the newest, then each month's most eventful days, year by year); a
  chapter from before conversation-days goes in by its words while lifelog holds its turns, else as its summary,
  context only. With their page and what code counts over
  the 1:1 messages (the exchange counts, below: who writes, deletes, opens, how fast each answers). Deleted messages are read like
  the rest, marked; a call is its call line. Each quote is found in a chat message or a recorded turn shown (a writing
  line's only in that writer's 1:1 chats) and kept with its time, so how well a line is backed (`backingOf`: solid on 3
  days or more, thin, old) is counted when read, never stored. Rebuilt whole at most weekly, when what was said
  changed. Psychology lives here only, in accepted terms (Big Five, values, attachment, Gottman's
  moves, social exchange) with the behaviour that shows it; pages stay facts.
- **The index** (`LIFE_STATE_DIR/memory/index.sqlite`): rebuilt from observations and units (`reindex`); the watcher rewrites only the rows of the units it rewrote in place (`reindexUnits`), and rebuilds it all when a unit went or a code rule dropped or took one back, or an input is newer than it (`readStaleness`); read by the CLI and the connector.
- **Histories** (`personal/histories.ts`, `memory/histories/`, off until the `histories` add-on; shown in the person read: the story in its `story` part, the months in its `year` and `month` parts): each closed month between him and someone with a page, summarised once from their one-to-one exchanges (the stream the exchange counts count) and the summaries of the conversations recorded in person where their voice is named (`heardPersonOf`), in time order (a call of 30,000 characters at most, a large month in parts; a month with no conversation in person is shown exactly as before they were read, so its reading stands), every quote found in a message shown and kept apart from the summary; then the story of the years through the last closed one. What is pending is derived each night from the stored hashes, the newest months first, 200 calls a night at most; the present month stays the situation's. The histories' work is read before the night writes its conversation summaries, so a month that just closed is read once more the next night when its last conversations are summarised that night. Later inputs (episodes with them, photo-days, the focused reads) join as new keys of the same call.
- **Links** (`memory/links.ts`, `memory/links.jsonl`): each night, after the index, one call per matter is shown its open steps (as `matterOf` finds them) and its later steps, and says which later one shows an open thing ended. Code keeps a link only when both ends were shown, the later one is later, and its words are found in the later one's quote. Each judged batch is one appended line, which is also the record of what was judged, so due work is derived: the oldest first, 10 calls a matter and 100 a night at most. A found ending ends its step at once, "probably" (shown with its words; a matter it closes reads `probably_done`); he gets every ending as a check to answer in conversation (`checksNow`; written as a fact check with `endedBy` set, `memory/fact-checks.ts`, only with his answer): right is the existing `outdated` correction and closes it, wrong removes the link between those two ids for good and reopens the step (a step re-read under a new id can be tied again; `memory/endings.ts`, the one place readers learn of links).
- **Matters** (`memory/matters.ts`, `memory/matters.jsonl`): each night, after extraction, a call reads the episodes of the night's days not placed yet, with the observations read from their units (importance 1 and up: an errand's small steps are rated low; a unit no episode holds is shown as an episode of its own) and his new to-do items, and the matters already running (name and newest step), and says which belongs to which matter, a new one included. Code keeps a placement only when its record was shown and its words are found in that record's own text, and takes ids from his directory only. The model places episodes; code stores one as its units, so steps are units, observations and to-do items, never episode ids. Each call is one appended line, which also records what was offered, so due work is derived and a record placed nowhere is not asked again. Open, matter status and the people of a matter are worked out when read (`matterOf`, `memory/matter-read.ts`), not stored; every reader of what is open goes through it (`read_day`, a person's page, `read_matters`, `read_matter`, the links step).
- **Exchange reads** (`memory/exchange-reads.ts`, `memory/read-replies/<YYYY-MM>.jsonl`; the mentions read is core, connection and conflict the `relationshipReads` add-on, stored and read by `bun life memory exchange-reads` and nothing else yet): the three reads of an exchange (connection, mentions, conflict), for each exchange of his two-way one-to-one chats finished in the night's days, in calls of 30,000 characters at most, one chat at a time. Each reply is one appended line, stored as given with what made it, the wording's digest and the keys of the messages it read; a new wording adds lines and rewrites none. What is pending is derived each night from the stored lines: an exchange is read by a read when a line of its current prompt lists it with exactly its messages today, so a grown exchange is asked once more and an unfinished one never. An exchange copied in late with old times is never asked.
- **Conversation summaries** (`memory/conversation-summaries.ts`, `memory/spoken-conversations.ts`, the same `read-replies/` store): a spoken conversation (his recorded speech cut at 5 minutes of quiet, finished) of at least 15,000 shown characters with another voice gets one summary per part (150,000 characters at most, cut at the longest silence), asked from every line with the words fetched from lifelog, a size of 200 words per 15,000 characters (300 at least). It is a fourth read: pending and current are derived from the stored lines and the keys of the turns in lifelog's store, so a voice renamed asks again and hides the old line. The night examines conversations with a turn first seen in the last 7 days and those of a line that lost a key; 40 calls a night, newest first, all passes together. Shown by `fetch person:me/conversation/<first turn ref>`, `read_day` and `search` (indexed in `searched_texts`).
- **Voice naming** (`memory/voice-naming.ts`, `memory/naming-context.ts`, `sources/lifelog-voices.ts`, the same `read-replies/` store, off until his `voiceNaming` setting; stored, shown only in `fetch` as "probably X" behind his `voiceGuessesShown` setting, `memory/voice-guesses.ts`): a fifth read, one call per part of the conversations the summaries examine that has a voice nobody named. Three rules made by code decide what the model is shown: the phone calls that overlap the part (picked up, or with no end seen and starting inside it), a brief for each person who could be there, and who could be there (at most 12). A voice lifelog recognised by sound whose person could not be there is shown as an unnamed `V`. "Heard in person" for this is stricter than for closeness: only a voice his own answer named, outside a phone call he had with that person, counts (`readHeardInPerson`; closeness counts every turn, `heardTurnsOf`). Lifelog says who answered or recognised each voice and whom it sounds like through `GET /speakers/voices` (a Lifelog Host without it fails the step with "needs the new Lifelog Host", logged, and the night goes on). The reply is checked against what was shown before it is stored; a guess never acts, never reaches lifelog, never makes or folds a person and changes no line extraction or the episodes read. Pending is `replyOf` over the part's keys, decided before any read of lifelog (a night with nothing new makes no call to it; a part with a voice lifelog named by sound is read again until the night stops examining it), so a renamed voice asks again. 40 calls a night, newest first.
- **Coverage** (`memory/coverage.ts`): whether a source that captures on its own was captured on a day, worked out when read from the units held, each source's first day, the day's units file, the record of what each publication read (`memory/publications.jsonl`, in his data because every worktree shares the units it describes) and, for the pendant, the recorded days (`LIFE_STATE_DIR/memory/recorded-days.json`, `memory/recorded-days.ts`: the local days lifelog says it recorded on, asked whole each night so no read waits on lifelog). Three states, never "quiet" by default: captured, not seen, unknown. `read_day` shows a day's; the person read says, by month, the days a source of theirs was not seen or unknown; the counts and the histories will count only captured days. Not yet known: an archive stopped under a running night, a bridge logged out.
- **The mentions** (`LIFE_STATE_DIR/memory/mentions/<month>.json`, `memory/mentions.ts`): the people talked about that the stored replies of the mentions read hold, checked against the sources and kept a file a month (by day inside) with the words as written, never a person, so a reader of one day parses one month. The night rewrites the files whole from the replies stored so far, and writes nothing when a source failed. Who is meant is `placementOf` (`memory/who.ts`), worked out when read: by name, or by his relation word (`my father`) when exactly one of his ties (`memory/ties.ts`, from his directory's relation text) is that relation.
- **The exchange counts** (`LIFE_STATE_DIR/memory/exchange-counts.json`, `memory/exchange-counts.ts`): what code counts between him and each person over their one-to-one chats and mail threads, one row per exchange (who opened, messages and deletions each way, minutes to each answer, its days). The sources are the truth: the night reads every year once and rewrites the file whole, and writes nothing when a source failed. The person read folds the rows by year; the persona folds the same rows over the messages it is shown. What code counts from the sources is derived state like this, never a file in `memory/` (decided 11 Nov 2026: it costs a minute and a half a night, and no invariant, migration or commit).
- **The passages** (`LIFE_STATE_DIR/memory/passages.sqlite`): rebuildable source-backed search text, separate from the index. The first message's unit owns a passage, identified by source and first-message id. Reconciliation follows complete grouping runs across midnight and month boundaries; search and embeddings use these same rows, including imported assistant messages excluded from model reading. Ordinary reindex reads metadata only.
- **The vectors** (`LIFE_STATE_DIR/memory/vectors.sqlite`): normalized float32 vectors addressed by text hash, in partitions of at most 4,096 rows. Exact scans retain bounded best candidates per partition; an index rebuild never re-embeds. Each watcher embedding pass selects at most 256 missing hashes in SQLite, newest first, before loading their texts; arrivals precede historical backlog. Pruning compares stored hashes in SQLite, without loading the corpus. Episode search text lives in the rebuildable index.

Model output is cached by unit hash and prompt version, so a night re-reads only what changed.

**Prompt parts.** A paragraph of a prompt that judges a person, a relationship or his own life sits between `<!-- part:<add-on> -->` and `<!-- /part -->` (inline, no nesting; `models/prompt-parts.ts`; the prompts that hold one: `partsIn` of each file). A call is shown the file with the parts of add-ons that are off cut out and the markers of the rest removed, after the owner rule, with `{{owner}}` and `{{language}}` filled; a prompt's name, not its text, keys its outputs. An output is stamped `<prompt>-without-<off parts, sorted>` when a part was off, and `isPromptVersion` counts any variant as the same version, so switching an add-on re-runs nothing. Two call parts no add-on switches: a call turns one on (`callParts`, `step.ask`), stamped `-with-<its on call parts, sorted>`, and absent it the part is cut out. `mayKeep` is on when his words on what Life may keep (`truth/me.md`) are given in the call's context; `inPerson` when a history month's call shows a conversation in person. The close flag of the context is sent only with `relationships` on (`refContext`), and a page's frozen sections (Between us, Views, Health, while their add-on is off) are neither offered to the model nor aged: their lines stay, hidden by the readers.

**Off hides, never deletes.** The steps that compute (extraction, pages, matters, links, appointments) never see an add-on's being off: they read every observation as it stands, so no stored result or input digest changes with a toggle. Readers hide. A page read drops the frozen sections (`shownBody`, from `layoutOf`); `settle` and `assemble` carry a frozen section's lines through every page build untouched, so the page file keeps them and turning the add-on on shows them again. An observation cited only by lines of a frozen section (`frozenOnlyOf`, read with the status inputs by `readReaderStatusInputs`, only while an add-on is off) is hidden by the readers: the index (at its next build), so search and `fetch`; `read_observation` and `read_memory_changes` (which also leave out the frozen sections' lines in page diffs and cites); the fact checks; and the night's email, for observations already on a page (tonight's new ones are counted before the pages are written, so a new one is not yet known to be frozen). An observation no page line cites is not hidden. The Past calendar's event notes read the index, so they follow the hiding; appointments, the auto-add of a to-do, matters and open items are steps that compute or act and deliberately stay unhidden (the practical Life is the core). The readers that hide ask `forReaders` (`memory/status-inputs.ts`) for the frozen set; `observationsNow`, which the computing steps use, never reads a page file for it.

### Why one compressed layer

Raw search scales; reading does not. A day of speech is on the order of 100k tokens, so the largest context holds about
a week. Hence one compressed layer, the pages, each line cited. Not justified so far: an atomic-fact database, graph
databases, contradiction resolvers, deep summary hierarchies. One summary is justified (his decision of 5 Nov 2026):
the situation, where things stand now, since broad questions ("am I still with her?") found only scattered facts. This limits memory structures, not initiative: raising things
unasked is the agent's job.

Time is modeled without a new store: said (`at`), valid (`validFrom`/`validTo`), event (`when`), recorded
(`madeBy.run`), retired (`supersessions.jsonl`), and every page version is in the data repo's git.

### The owner's own page

`memory/pages/people/me.md` (`OWNER` in `memory/read-truth.ts`) is built from the observations like every page, with its own
sections (`layoutOf`, `page-format.ts`), so changing its shape costs a rebuild of one page. `person me` adds the owner's goals,
read from `truth/me.md`.

## Relationships and closeness

A question like "what is my arc with this friend?" needs more than recent logistics. The design:

- **Who gets a page is a closeness level** (`apps/server/src/memory/closeness.ts`), judged by a model on numbers code counts from
  raw signals only (two-way 1:1 message days, voice presence, recency), never from model output, so there is no
  feedback loop. Personal and work closeness are separate scores. Service accounts are not people. Close family keeps a
  floor. The owner can override any level in a sentence; there is no list for the owner to keep.
- **A section that does not age:** close people's pages have "Between us" (role, agreements, boundaries, dynamics,
  turning points), each line cited and attributed; a line with no new evidence in 12 months moves to History.
  Close means close personally now or once, so a dip never empties the section.
- **Old facts can be corrected:** extraction also shows an episode the facts of the last year about the close people
  (`priorFor`), so a newer fact can retire an older one.
- **Arcs are assembled when asked** (the relationship section, History, paged evidence, episodes, a month timeline),
  never stored as a summary; the present is (the situation), and what keeps repeating is (the persona).
- **Names:** misheard and other spellings resolve to the person, and the Mac's Contacts name handles Life can't place.
- **Details** are only what is already a field (his directory, then his Contacts: `detailsOf`, the one place for them and
  for a birthday). Everything else known about someone is a line of their page: models read prose, and a field earns
  its place only when code computes with it (a birthday, a handle). A model step that tagged facts as details (6–8 Nov
  2026) only copied page lines, and went.
- **What a model call is shown:** its context (the same for every call of a run, so it is cached) holds the people close
  to him now, personally or at work, and the projects underway (`refContext`, `contextPeopleBy`). Everyone else on the
  directory comes in a call's input as `involved` when the call involves them: its units' people, the names their words use
  (`namedIn`), earlier facts' or episodes' refs (`involvedOf`). So a call stays small as the directory grows by hundreds a
  year, and nothing is forgotten: replies are checked and names resolved against the whole directory.
- **Historical collection:** `bun life memory historical-units` collects bounded owner-local months without models, voice writes or file descriptions, ending before the nightly window. Historical zones use the offsets of photos that place him and of sent mail; gap rules are in [operations](operations.md#historical-collection). Imports and model backfills require the optional `backfillEngine`; there is no scheduled model backfill until prompts are frozen. The night keeps the ordinary engine.

**Phone calls** are events of their chat, including call-only chats, never a second record: a call reads as a line of its chat-day ("(audio call
10:02–10:40, 38 min)"), and a voice lifelog heard over a phone, or nearby but not with him, reads with that prefix
(`heardAs`, words.ts), so the episodes call joins a call to what was said in the room by time and by how voices were heard,
never by a timing rule of Life's. Phone & FaceTime has its own `phone` source, read from the archive (see
[sources](sources.md)); messaging apps retain their own calls. A completed 1:1 call from any source sets the same
voice day as a recording in `chatDays`, once per person and local day, and never adds message weight. A call-only
chat resolves identity through its handles, never its display name. Voice attribution remains the model's reading.

Known limits: no Telegram calls, no unrecorded time together, no location history before lifelog's; a spoken claim about
someone else is capped at 0.6 confidence.

## Why the memory stays on the Mac

- The owner data dir is a local git repository with no remote: the nightly commits and never pushes.
- The archive (deleted messages, old note versions, phone call history, Screen Time's records) is the only live copy of what the apps delete or prune; it lives in
  Application Support and in the encrypted backup, nowhere else.
- The exception is the model: the text a step reads is sent to the provider of the chosen engine (Anthropic or
  OpenAI through the owner's subscription's CLI, or OpenRouter and allmodels.io with his keys: `docs/operations.md`, "Model engines"). Calls run in
  an empty temp folder with no tools and no instruction files, so recorded content reaches the model with nothing but
  the prompt. (A developer's benchmark, the question cases, gives one Codex call Life's connector, reads only.)
- The optional backup goes where the `backup` setting says (for example iCloud Drive), encrypted by restic.
- The connector is reached through the owner's tailnet (or a tunnel the owner controls), behind Life's OAuth.
  The owner's install is a bridge until #137: a Cloudflare Worker (`apps/edge/`) on every path of his public address passes
  each request as is to the Mac's Tailscale Funnel on port 8443 (HTTPS a VPN lets through, unlike the tunnel's 7844),
  so his connector's URL never changes. It decides nothing; the Mac's OAuth guards every path.

## The stack

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/readme/stack-dark.png">
  <img src="../assets/readme/stack-light.png" alt="Where Life runs. On the owner: the recorder and lifelog on the phone. On the Mac: Life.app, Lifelog Host, the speech models, the embedder, the bridges and the memory. Outside the Mac: the model, the assistant over Tailscale, Google for the calendars or Tasks, ElevenLabs Scribe, the encrypted backup and Life's mail to the owner.">
</picture>

| Part | What it is |
|---|---|
| Reading | The owner's Claude or ChatGPT subscription (Life runs `claude` or `codex`, with no tools), or an OpenRouter or allmodels.io key, each in four tiers: fast, main, deep and judge. Outputs are cached by input and prompt, so a night re-reads only what changed. |
| Search by meaning | [EmbeddingGemma 300M](https://huggingface.co/google/embeddinggemma-300m), run by llama.cpp in Lifelog Host, for voice and memory alike (`core/embedder.ts`). No text leaves the Mac to be embedded; without Lifelog Host, search is by words only. |
| Transcription | lifelog's: ElevenLabs Scribe by default, paid by the hour of speech; or its speech service on the Mac (Nemotron 3 for who speaks when, VoxLingua107 for the language, Parakeet Ultra for the words), with Scribe only for Thai ([lifelog's processing](../apps/lifelog/docs/processing.md)). |
| Voices | The MECT-B2 model, on the Mac, learning only from the names the owner gives. |
| Photos | Qwen3.5-9B under llama.cpp, on the Mac, describes each photo when `describePhotos` is set (`models/describer.ts`). |
| Server | Bun, Hono and TypeScript; the connector is an MCP server with its own OAuth sign-in and pairing codes. |
| Apps | Life.app, a SwiftUI menu-bar app that keeps it all running; Lifelog Host on the Mac; lifelog's iPhone and Watch apps in Swift 6, and its Android capture app in Kotlin. |
| Memory | Plain text (Markdown and JSON lines) in a git repository with no remote; SQLite for the archive, the search index and the vectors. |
| Bridges | A local Matrix server (Synapse) with mautrix bridges, one background job, for the networks with no Mac app. |
| Network | Tailscale: Claude Code reaches the Mac on the tailnet; claude.ai and ChatGPT through Tailscale Funnel, a public address with only Life's sign-in in front. |
| Backup and mail | restic, encrypted, wherever the `backup` setting points; Resend for the report, else a notification. |

## The code

The server's code (`apps/server/src`) is in layers, and dependencies point one way:

```
core  ←  records  ←  models, sources, todo-list, payments  ←  memory  ←  personal  ←  host
```

| Folder | What it holds |
|---|---|
| `core/` | Clock (with calendar-day arithmetic, `daysBefore`), list cuts (`lists.ts`), paths and the platform, settings and Life's fixed names (`names.ts`), process, lock, log, secrets, redaction, hashing, small JSON files, which outputs are on |
| `records/` | Every record Life writes, as zod schemas, one file per record (`unit.ts`, `episode.ts`, `observation.ts`, `fact-check.ts`, `ledger-entry.ts`, `source.ts`), plus `truth.ts` and the fields they share (`fields.ts`) |
| `models/` | The model providers (`PROVIDERS`), the call and its cache |
| `sources/` | One reader per outside store, and the source contract (`contract.ts`) |
| `todo-list/` | The to-do list contract (`TodoListBackend`), its two backends |
| `payments/` | The payments contract (`PaymentsBackend`) and its one backend, his `money` CLI |
| `memory/` | The pipeline (units, episodes, observations, pages), the ledger and its readers, people and places, search, the source registry (`sources.ts`, with the agent's own source) and the nightly email's rendering |
| `personal/` | The add-ons' code (`docs/glossary.md`, "add-on"): personas, histories and the person read's parts they supply (`person-parts.ts`, with `readPerson`, the person read as the connector and the command give it). Imports `memory/`; `memory/` never imports it, so the core runs with every add-on off |
| `host/` | What runs, and the only layer that knows which host it is on: the jobs (watch, hear, archive, nightly, backup), the asks (`asks.ts`), `changeTodoItem` and `inbound`, the CLI and its commands (import, export, init, health), `http/` (the connector, the issuer, the brand), `status/` (the status snapshot, Life's status), and the outputs (report, the Past calendar, the appointments) |
| `test-data/` | The made-up data tests read |

What the check enforces is the order: no file imports a layer to its right, fallow's boundary zones (`.fallowrc.json`)
fail any that does, and `scripts/imports.test.ts` fails any import cycle. Within it, a capability's contract has its own
`contract.ts`. The layers are folders, not packages: a folder becomes a package only when a second app imports it.
The reasons are in the [architecture plan](plans/2026-10-22-architecture.md).

Connectors are built in, not loaded. Every source and to-do backend ships inside Life, behind its contract, and an
install turns on the ones it wants in its settings (`sources`, `todoList`). That is what packaging Life for others
needs. A runtime plugin loader would let outside code run inside Life with all of the owner's data, and freeze the
contracts for code Life can't change, so it waits until someone outside Life wants to write a connector (decided
4 Nov 2026). Until then a new connector is one reader file and its descriptor in `SOURCES`.

The repo around it is a Bun workspace:

| Path | What it holds |
|---|---|
| `apps/server` | The code above, with its runtime dependencies. The helper (`scripts/helper.ts`) compiles it for Life.app |
| `apps/mac` | Life.app ([its README](../apps/mac/README.md)) |
| `apps/edge` | The Cloudflare Worker in front of the owner's public address, a bridge until #137 (deploy steps in `wrangler.jsonc`) |
| `packages/config` | The shared TypeScript base (`tsconfig.base.json`), which the root `tsconfig.json` extends |
| `scripts/` | The helper, the app build, releases, the check, the benches and evals. Outside the zones; they import the server as the workspace package `@life/server/src/…` |
| `prompts/`, `assets/` | The model prompts and what the pages, the app and the email show (`LIFE_CODE_DIR`, `docs/operations.md`) |
| `derived/` | Generated, gitignored: a checkout's state |
| root | `bts.jsonc` (so `create-better-t-stack add` works), `bunfig.toml` (a hoisted install, for Codex's binary), the workspace's version catalog |

No Turborepo: `bun run check` runs every step at once, and a task cache would buy two short steps. There is no CI: the pre-push hook runs `bun run check`.

## The app

`Life.app` (`apps/mac/`, SwiftUI, menu bar) is how Life is installed. It runs the compiled helper (`scripts/helper.ts`): the
archive and the watcher kept running, the nightly tick every 30 minutes, data and state under `~/Library/Application
Support/Life`, secrets from the Keychain. The app never reads Life's files: it asks the helper (`app`, `settings`,
`init`, `pair`, `connect`), so their shape lives in one place. It starts Life at launch. Updates come through Sparkle.
Its menu-bar panel and status window are native SwiftUI, reading the status snapshot from the watcher's local status reads
(`apps/server/src/host/http/status-reads.ts` on `LOCAL_PORT` (`http.ts`), behind its local key (`keyRefusal`, `local-key.ts`; `LIFE_STATE_DIR/local.key`, mode 600); no tunnel ever points
there): `docs/status-reads.md`.

## Pages

Life serves no web pages. The watcher's server serves the connector, its issuer and the brand, and none of the owner's
data before a token. Every route is a Hono app; `server.ts` mounts one app per port and `Bun.serve` only listens. The web
app and the legacy portrait (`/me`) were removed on 8 Nov 2026; the server version will build what it needs.

- **The brand** (`apps/server/src/host/http/server.ts`: `/docs/brand.md`, `/assets/brand/tokens.css` and the files they link), open to all: Life's
  own files, nothing of the owner's, for his agent to style what it makes for him.

Everything Life shows follows Life's brand, one source in `assets/brand/tokens.css`: where each surface takes it is
`docs/brand.md`.
