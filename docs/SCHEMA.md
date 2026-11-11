# memory/ (in the data repo, `OWNER_DATA_DIR`): what the files are

Reference: every file in `memory/`.

Life's long-term memory, written for a future system that has never seen this code. The enforced copy of every record below is its zod schema in `apps/server/src/records/` (truth, ledger, sources, units,
episodes, observations, statements), with the fixed names in `core/names.ts`.
Everything is plain text: JSON Lines (one JSON object per line), UTF-8. Times are ISO 8601 with a zone; dates
(`YYYY-MM-DD`) and local times are where the owner was at that instant (`zones.jsonl`), whatever zone the Mac is in
when they are read again. Every record has `schemaVersion`; a record a model judged says
which model and which prompt version (`prompts/<name>.md` in the code repo) did it.

The raw material stays in its own app (lifelog, Messages, Mail). These files hold ids, refs, hashes,
metadata, lifelog's own chapter summaries (on the chapter units stored before conversation-days), short model verdicts and, in observations, short verbatim quotes; never
whole transcripts or message bodies (but an ask's words, `ledger.jsonl`).

## Words used below

- **Type**, what a unit or observation is. One of: `to_do` (To-do), `promise` (Promise: the owner
  promised someone to do it), `waiting_on_someone` (Waiting on: someone owes the owner something), `choice` (Choice), `about_a_person` (About someone: who they
  are, how they're doing, gift ideas), `preference` (Preference: what someone likes or dislikes, the owner included),
  `idea` (Idea), `news` (News: something changed in an area: status, problem, progress), `nothing` (Nothing).
- **When**, a date or deadline (`YYYY-MM-DD`) any type can carry, or null.
- **Area**, one of the owner's life areas: an `id` (slug) from `truth/areas.yaml`, or null when none fits.
- **Importance** 0-3: 0 nothing to keep; 1 keep searchable only; 2 worth a line on a person or area page; 3 the owner must
  act or must not forget.
- **Entity refs**: `person:<slug>` (`truth/people.yaml`), `project:<slug>` (`truth/projects/`), `area:<slug>`
  (`truth/areas.yaml`).
- **Birthday**: a person in `truth/people.yaml` may carry `birthday`, `--MM-DD` or `YYYY-MM-DD` when the year is
  known.

## units/YYYY-MM-DD.jsonl (layer L1)

One line per unit that started that day. A unit is one conversation-day (the turns of one recorded conversation on one
local day; or one of lifelog's chapters, stored before conversation-days, kept as stored and never built again while
its conversation is live, removed with it when lifelog retires or drops it: its conversation gets no conversation-days), one chat-day (every message of one chat on one
day), one mail thread-day, one note-day (what the owner changed in one Apple Note on one day), one repo-day (the owner's commits in one repo on one day), one device-day or one measurement-day. Deterministic code output only (no model's judgement): rebuilt by `bun life memory
episodes` for the days it covers; the conversation-days are also kept current by `bun life watch` (every change to a
conversation's turns) and checked by the nightly.

| Field | Meaning |
|---|---|
| `schemaVersion` | `1` |
| `id` | `unit_` + 12 hex. Stable: the same conversation-day (`lifelog` + conversation + day), chat-day (source + chat + day) or thread-day always gets the same id. A chapter unit keeps the id it was stored with (from lifelog's chapter id). |
| `hash` | 16 hex of SHA-256 over the unit's content (a conversation-day: its turn refs and marks, as Life holds no words; a chapter: as stored; chats and mail: each message's text and whether the owner sent it). Changes when the content does. |
| `source` | `lifelog`, `whatsapp` (Life's own WhatsApp archive, which keeps messages deleted for everyone), `line`, `instagram`, `linkedin` and `telegram` (from Life's own archive of each network's bridge, `line.sqlite` and so on, which keeps messages deleted for everyone; refs `<network>:<room>/<event number>`), `imessage` (Messages' chat.db), `phone` (Phone & FaceTime, the latest call versions from `archive/phone.sqlite`, table `calls`), `mail` (Apple Mail), `notes` (Apple Notes, from Life's own archive, `notes.sqlite`, which keeps every version), `git` (local `git log` of every repo under the `repos` setting's folder; commits are never extracted: code caps their importance at 1), `screen` (Screen Time, from Life's own archive, `screen.sqlite`, which keeps what Biome prunes; one device-day per device, key the device's Biome id, refs `screen:<device>/<app or web: domain>/<start>`; never extracted, importance at most 1), `apple-health` (Apple Health through lifelog, derived `watch/apple-health.sqlite`; one measurement-day per local day, key `apple-health`; activity, never extracted, importance at most 1), `claude` and `chatgpt` (the owner's own messages in their claude.ai and ChatGPT exports, each export kept whole as an export copy in `imports/<source>/` beside `memory/` (`conversations.json`, a newer export `conversations.<12 hex of its bytes>.json`, never replaced or merged), a conversation read at its latest version; a conversation `imported.jsonl` does not keep is dropped as `not-kept`; key `<source>:<conversation>`, refs `<source>:<conversation>/<message>`), `AGENT_WORD`, stored as written (`core/names.ts`) (a task the agent closed done: its outcome with the owner's ask's words, the agent's report, never the owner's; code raises its importance to 2, so it is always read) |
| `key` | The lifelog conversation id (a live one: units of a retired conversation are removed, its successor brings its own), the chat id (a Matrix room id of a bridged network, or a WhatsApp id such as `<phone>@s.whatsapp.net`, `<id>@g.us`, `<id>@lid`), the phone source’s remote handle or `group:<JSON participant array>` (missing handles: `unknown:<call id>`), the mail thread id, the note id, or the repo (its main folder name under the `repos` setting's folder: worktrees fold into it) |
| `date`, `start`, `end` | Local day; first and last instant |
| `title` | The conversation's title, else `Recorded conversation` (a chapter: its chapter title), chat name, mail subject, or note title (`(shared)` after a shared note's) |
| `summary` | A chapter's: lifelog's own summary (written by its model, not by Life), which marks the unit as a chapter; a repo-day's: below. Never on a conversation-day |
| `marked` | His words to Life, to keep, in it: the refs of the lines he gave Life to keep (a "hey Life" span or an ask's, a message to himself, a told line); it moves the hash, so the unit is read again, at importance 2 at least, and its text then ends with `MARKED` |
| `people` | Kept unresolved, as each source names them: `unknown:<name>` for each name lifelog gives someone who speaks in it (a name given to one turn names that turn only), `person:me` when the owner speaks (not on a chapter), `unknown:<sender>` for each sender of a chat or a mail, `person:me` for the owner. Readers map them as of their day (`unitNow`, `memory/who.ts`); older units may still hold `person:<id>`, which maps the same |
| `refs` | Where to find the raw material. A conversation-day: its first and last turn, `<jobId>:<turnIndex>@<turn start>`; its turns are the conversation's in [`start`, `end`). A chapter: `<conversation id>#<chapter id>` and its first turn. Chats: first and last message id (`whatsapp:<chat>/<message>`, `line:<room>/<message>`, `imessage:<guid>`, `phone:<chat>/<ZUNIQUE_ID>`), notes the first and last version (`notes:<note>/<version>`, the archive's rowid). Mail: every message id (`mail:<Message-ID header>`). |
| `stats` | `items` (messages, turns, or commits), `fromMe` (messages the owner sent, his turns, or his commits), `chars` (0 on a conversation-day: Life holds no words). Git only: `added` and `removed` (lines, without lockfiles, binaries and single-file changes over 3,000 lines) and `others` (author name -> commits; in a repo of one of the owner's projects every author's commits count, elsewhere only the owner's). A git unit's `summary` is the day's commit subjects, which makes them searchable; its refs are the first and last `git:<repo>/<sha>` |
| `drop` | Absent unless a code rule dropped the unit as obvious noise; then the rule's name (`no-summary` on an older lifelog unit, a conversation lifelog had not summarized: such a unit is replaced by conversation-days), `not-kept` (an imported assistant conversation the import step did not keep as about the owner's life, `imported.jsonl`), `life-output` (Life's own output: its chat, the `lifeChat` setting, and its nightly report and alerts, `Life · ` mail from the `mail` setting's sender), `duplicate` (same content as an earlier unit), `too-short`, `one-time-code` (a short message with a login code, or a mail whose subject says it is one), `newsletter` (Mail saw a list id or unsubscribe link and the owner never wrote in the thread), `not-a-person` (mail the owner never wrote in where no sender is someone he knows, a person `resolve` names or an address his Contacts hold, and none is a transaction (`transaction` on its source line; a bulk one is a `newsletter`); `search` still finds it; the owner's agents' reports, from the `reports` setting's senders, are left to the model), `automated` (the older rule `not-a-person` replaced on 4 Nov 2026: no-reply mail with no money, booking or deadline word in it). A dropped unit is never judged or extracted. |

Apple Health's source events are nights and workouts, each with `at` and `until`. Overlapping sleep segments count
once; a night belongs to the local day it began. `activityDay` builds the measurement-day's timed lines, without totals.

## verdicts.jsonl

The model's judgement of units, append-only, one line per unit and run, written by `bun life memory episodes` (one
call per day, with the day's episodes; before 18 Oct by a triage step of its own): `{schemaVersion: 1, unit, hash, type,
when, area, importance, topics, reason, kind?, madeBy: {engine, model, prompt, run}}`. `unit` and `hash` are the unit's `id` and
the `hash` of the content judged; `type`, `when`, `area` and `importance` as defined above; `reason`: one line from the
model saying why; `topics` (from `memory-triage.v3`, the same in v3.1; absent, read as none, before): one to three lowercase English
tags for what the unit is about, such as `philosophy`, `ai`, `construction` (code lower-cases, dashes and singularizes
them; the model is shown the 40 most used so far and asked to reuse them); `kind` (lifelog only): conversation,
small-talk, media, dictation, customer. Code caps a commit's importance at 1 (commits are never extracted). A unit's current
verdict is the latest line for its `id` and current `hash`: judged again when the content changes. It is reused while
the prompt version (`madeBy.prompt`: `memory-triage.v3` to v3.2 until 18 Oct, the owner's own views at 2 from v3.2; `memory-episodes.v2` on 18 Oct, `memory-episodes.v3` from 18 Oct, which also says who the day's unknown people are, `memory-episodes.v4` from 20 Oct, which weighs what goes on between the owner and the people close to them, `memory-episodes.v5` from 2 Nov, which times an episode by when it happened, not by everything about it, `memory-episodes.v6` from Nov 2026, which reads the phone's stays, makes only what happened an episode and judges only the new units, `memory-episodes.v7` since 5 Nov 2026, which links an unknown handle or name to the person on the map it is) is unchanged; a day is read again when one of its units has no current verdict by that prompt, or a `reread` names one of its units after its verdict, and then only those units go in full. The chat's own project decides an `areaHint`
the model is shown (`Chat` -> the projects whose `chats` list it -> their `area`); it is a hint, never an override. A unit with no line for its current content is
not judged yet; a dropped unit's lines are ignored.

## files.jsonl

What Life read off the files messages carry, append-only, one line per file and reading, written by the sweeps
(`describeFiles`, `apps/server/src/memory/message-files.ts`): `{schemaVersion: 1, ref, hash, what?, text?, madeBy?}`. `ref` is where the file
was met (`imessage:<attachment guid>`, `whatsapp:<chat>/<message>`, `line:<mxc url>`, `mail:<Message-ID>#<MIME part>`, `notes:<attachment id>`);
`hash`: 16 hex of SHA-256 over its bytes. `what`: the model's one sentence on what it is and shows (`madeBy` as for
verdicts, prompt `files.v1`); `text`: the words on it, on one line, at most 1,000 characters (a photo's from the model,
without document or card numbers; a document's or a PDF's text layer read by code, with no `madeBy`). The latest line
for a ref is how its message shows the file (`[photo IMG_2910.HEIC, described by Life: … | text: …]`), also once the
file is gone from the Mac. A file met under a new ref with a known hash (a forward) gets a copy of that line, with no
model call. A prompt bump reads the model's files again. Unlike the rest of memory/, this holds documents' words:
ID cards, invoices, plans.

## episodes/YYYY-MM-DD.jsonl

What happened in the owner's life: one line per episode (a trip, a dinner, a flight, a coffee), written by
`bun life memory episodes` (prompt `memory-episodes.v7`) from one day of units read together across every channel, in
time order, with where his phone stayed and the episodes of the day before that may continue into it (the same call
writes the day's verdicts). A plan is never an episode: it is a fact with its `when`. A day read again sends only its
new units in full; its episodes as they stand are the state, and the reply gives the new or changed ones and those
gone, merged into the day's file as `episodesNow` merges (`dayFileOf`); an episode by an older prompt is not state, so a
new prompt reads the day afresh. Git keeps the old files. An episode the owner hid (`wrong`, `not-important`) stays in it, and each reading of its day is shown it with his note, so it is not made again; a `wrong` one has its day read again. An episode a later day sees again keeps its id there, and the latest
day's line is its current state, and its units are those of all its days' lines. Where he was during an episode (its
stay) and which facts are its own (`readBy`) are derived, never stored. Model-owned, like `people-inferred.jsonl`.

| Field | Meaning |
|---|---|
| `id` | `ep_` + 12 hex of SHA-1 over its day and units, or the id of the earlier episode it continues. |
| `day` | The day whose units it was read from. |
| `title` | Short and factual, naming who and what. |
| `what` | One to three factual sentences: what happened and what came of it (`why`, a reason, before Nov 2026). |
| `within` | The id of the episode holding it (a dinner within a trip), or null. |
| `start`, `end` | Local `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, or null when the sources don't say. |
| `place` | As the sources name it, or null. |
| `people` | `{ref, role}`: `person:<id>` or `unknown:<name>`; `with` (takes part), `told`, `organizer`. The owner is implied. |
| `units`, `copies` | The day's units that are its evidence; those that are a second copy of another (never read twice). |
| `importance` | 1 ordinary, 2 worth remembering in a month, 3 a landmark. |
| `madeBy` | The model and prompt. |

## observations/YYYY-MM.jsonl (layer L2)

The memory ledger: small dated claims, each cited to the exact place it comes from, one per line, filed by the
month of `date`. Append-only: a line is never edited or removed; one a newer observation replaces is retired in
`supersessions.jsonl`. Written by `bun life memory extract` for kept units (importance 2 or 3; a importance-1 unit stays in the
units, searchable, but is not read in full). From `memory-extract.v3` a kept unit is read with the rest of its episode
(every unit of it worth a searchable line), and with the earlier facts about the episode's people, which it may retire.
From `memory-extract.v4` an episode is read across its days, from the day before its first unit to read and cut
between days to fit a call (a unit in several episodes with the one reaching furthest forward, of those the smallest),
and what the lines show ended is written as what happened, not as still open. From `memory-extract.v5` (20 Oct) the
`about_a_person` type (then `person`) also holds what is between the owner and someone, in someone's name, and the earlier facts it may retire
include the `about_a_person` facts of the last year about the people close to the owner (`priorFor`). The model context marks those
people `close: true` (`refContext`, `personallyClose`: a personal level inner, regular or faded: once close counts, so the backfill reads an ex's days as close ones).

| Field | Meaning |
|---|---|
| `schemaVersion` | `1` |
| `id` | `obs_` + 12 hex of SHA-1 over unit id, type, normalized quote and normalized text: the same claim from the same unit always gets the same id (read again under a new prompt, it is written again under the new run). The id stays if the unit's id later changes (`unit` and `source` are remapped), because pages and supersessions cite it. |
| `unit` | The unit (`unit_…`) it was read from. |
| `type`, `when`, `area`, `importance` | As defined above (`nothing` is never an observation). |
| `text` | The claim, one English sentence, self-contained (names, absolute dates). |
| `quote` | The source's own words for it, verbatim (original language, original spelling). Code checked it is in the source text the model read, comparing without case, accents, quote style or spacing, and stores the source's exact substring. That text has secrets (passwords, card numbers, IBANs, codes) replaced by `[… removed]` first. |
| `source` | `{channel, ref}`: channel `lifelog`, `whatsapp`, `line`, `instagram`, `linkedin`, `telegram`, `imessage`, `mail` or `notes` (ref `notes:<note>/<version>`); ref is the exact place: lifelog `<jobId>:<turnIndex>@<capturedAt>` (one transcript turn), chats and mail the message id (`whatsapp:<chat>/<message>`, `line:<room>/<message>`, `imessage:<guid>`, `mail:<Message-ID>`). An observation is new (the nightly email) when no earlier one cites its ref (`newSince`). |
| `speaker` | Who said or wrote the cited line: `person:<slug>`, or `unknown:<label>` (a phone, an address, lifelog's `speaker_1`, or a name lifelog knows and the map doesn't). |
| `speakerName` | Optional, from 11 Oct: a readable name for an `unknown:` chat sender, the title of the 1:1 chat they wrote in. |
| `speakerFrom` | Optional, from 21 Oct: the handle or name the author came from (a chat sender, lifelog's id for a voice). Readers resolve the author again from it (`aboutNow`; for a fact from before it, a 1:1 chat's handle). An author who is someone else now is that person in every fact of the unit (speaker, entities), never the owner, nor someone who still writes in that unit as themself, and their old name is swapped in the sentences (worked out at every read, never stored). A voice keeps lifelog's id; an unknown voice whose id the map lacks resolves by lifelog's name for it, while a known one keeps its filing: a later identity fix of an author needs no new reading. A non-author misfiled in a group chat still needs `reread`. |
| `at`, `date`, `tz` | When the cited line was said or written (ISO with zone), its local day, and the IANA time zone that day is in (`zones.jsonl` at `at`; before 18 Oct, the Mac's when the record was made). |
| `about` | From `memory-extract.v3`: the one person or project the claim is about (`person:me` for the owner), also in `entities`. |
| `modality` | From `memory-extract.v3`: `fact`, `plan` (settled for later), `reported` (someone says it of a third person) or `conditional` (a hypothesis, a joke, a quote, an AI's text read aloud). |
| `entities` | Entity refs the claim names or involves (people, projects). Every ref was in the list the model was given, or was resolved by code (handles, names, aliases); names it could not resolve are in `unresolved.jsonl` (an unknown chat sender is only the `speaker`, not listed there). |
| `confidence` | 0-1, the model's; code caps it at 0.6 for a recorded (lifelog) claim about someone other than the owner. |
| `validFrom`, `validTo` | Days the claim holds, or null. |
| `madeBy` | `{engine, model, prompt, run, unitHash}`: the extractor (`claude` or `codex`, and its model), its prompt version and the unit content it read. Records written before 14 Oct have no `engine`: it reads as `claude`. |

## extracted.jsonl

Which units an extractor version has read: `{schemaVersion: 1, unit, unitHash, prompt, run, observations, at, unkept?}`, one
line per unit and run, `observations` being how many it kept (often 0); lines of 21 Oct 2026 also carry `people`, ignored. A unit is read again when its `unitHash` or
the prompt version changes, or when a `reread` correction names it after its last reading (the night reads the last
7 days, `backfill` older ones). Who someone is needs no new reading: readers resolve a fact's author and entities as of
today. A unit read before that its latest verdict no longer keeps (its content changed, or a `reread` judged it below
`KEEP_AT`) gets a line with `unkept: true` and `observations` 0, nothing read, so its earlier facts stop showing (and
what they retired shows again, as after any re-read); kept again, it is read again (an `unkept` line is no reading). Only the latest
extraction of a unit counts: observations from an older one are ignored (`replaced`), and so are all of a unit that no longer exists or that a code rule now drops (`gone`: a conversation
regrouped, Life's own mail).

## unresolved.jsonl

Names Life could not map to `truth/`: `{schemaVersion: 1, surface, unit, observation?, date, via, at}`. `via` is
`model` (the extractor named someone not on the map) or `speaker` (lifelog named a voice the map doesn't know). Nothing here waits on the owner; since 18 Oct a name the extractor
could not place is no longer asked about (the episodes call asks about the day's unknown chat senders and lifelog voices).

## people-inferred.jsonl

Who Life thinks an unknown handle or name is, written by `bun life memory episodes` (the same call that reads the day;
before 18 Oct by an infer step of its own), append-only: `{schemaVersion: 1, id, surfaces, name, person?, relation, area, project, confidence, evidence: [{unit,
quote}], madeBy, at}`. `id` is `inf_` and a slug (truth ids never start with `inf_`), `surfaces` the handles (a phone,
a WhatsApp or Matrix id) or names it goes by, `name` a name or, when the messages give none, a description ("the
plumber changing the shop sink"), `relation` how it relates to the owner, `evidence` quotes checked to be in the messages
the model read (a unit of that day), `person` (from `memory-episodes.v7`) the person in `truth/` it is, when the call
judged it is them, null when it judged no one there is (absent on older guesses, which are asked once more when their
surface comes back). Every id a surface was given reads as what the surface reads as now: his `this-is`, `truth/`, else
its latest confident guess, the person it links to before the guess itself; never one his `not-this-person` rules out (`foldsOf`). Every handle and name of a day that does not resolve yet is asked about, with the
units it appears in, each time that day is read; an unsure answer is asked again with the next day's evidence. Model-owned: the resolver uses it automatically,
below `truth/` and the owner's corrections, from confidence 0.5; the latest record for a surface wins. It never
writes `truth/`.

## repos-inferred.jsonl

Which project a code repo belongs to, as Life guesses, written by `bun life memory repos --scan` (the fast-tier model, the
nightly's first step), append-only: `{schemaVersion: 1, repo, project, area, newProject, why, madeBy, at}`. `repo` is a
folder name under the `repos` setting's folder (worktrees fold into their main repo; the first run also mapped `owner/name` repos only on GitHub); `project` an
id from `truth/projects/`, else null; `area` the project's area, else the repo's own; `newProject` ("Cove: macOS call
recorder") a project the owner might want, only a suggestion; `why` one sentence. Only a repo with the owner's commits is asked about,
once per prompt version. Model-owned: used at once, below `Project.repos` in `truth/` (the owner's map); the latest record for a
repo wins. A repo on a project (either way) counts every author's commits in its git units. It never writes `truth/`.

## imported.jsonl

Which conversations of the owner's claude.ai and ChatGPT exports are about the owner's life, written by `bun life import
<folder>` (the fast-tier model, once per conversation and prompt version, from its title and the start of the owner's pruned
messages), append-only: `{schemaVersion: 1, conversation, keep, why, hash?, madeBy, at}`. `conversation` is
`<source>:<id>`; the latest line per conversation wins. `hash` is a hash of what the model read (the title and the start
of the owner's pruned messages): a newer export judges a conversation again only when it differs. A line from before
`hash` stands for the conversation's version in the oldest export copy holding it. Every pruned message is searched; the units of a conversation
not kept are dropped by the `not-kept` rule (`units.ts`), and model-free historical collection indexes the conversations' days. Searchable messages remain available even when their conversation is not kept for model reading.

## closeness.jsonl

How close each person is to the owner, written by the nightly's `closeness` step (the fast-tier model), append-only:
`{schemaVersion: 1, person, personal, work, service, why, counts, madeBy, at}`. `personal` and `work` are each `inner`,
`regular`, `acquaintance` or `faded` (was close, not any more); `service` a business or a bot; `why` one line. Code
counts, for everyone over the last 3 years, the days a 1:1 chat went both ways, the days a mail thread did (apart:
mostly work; never a group nor a mailing list) and the days they spoke in the owner's recordings (lifelog's speakers, live
conversations), weighted by how recent (`recent` halves every 30 days, `lasting` every 365); the model judges those
counts with who they are on the owner's map (everyone on it, and anyone with a page, is judged, counts or not; close family is close whatever the
counts, the prompt's rule). `counts` is what it judged, rounded, so a person is asked about again only when their counts
move or the prompt changes. The latest record per person wins (a person folded into another: the kept one's); the owner's
`closeness` correction wins over it. No model output feeds the counts. Model-owned: who has a page follows it at once.

## detail-tags.jsonl

Written 6–8 Nov 2026 only, by a step that tagged which kind of detail a fact states (`{schemaVersion: 1, observation,
detail, madeBy, at}`); read by nothing since (docs/architecture.md, "Details"). Kept, as all of memory is.

## decisions.jsonl

Historical: Life's old fact checks and what he answered on its decisions page, and his loops' decisions. Nothing reads or
writes it any more; it stays on disk.

## told.jsonl

What he told Life in a chat, append-only, one synchronous line each outside the lock (`recordTold`, `memory/told.ts`, from
the connector's `tell_life`): `{schemaVersion: 1, at, said, asked?}`. `said` is his words verbatim; `asked` is the question
he answered, if any. Read back as the source `told`: his lines are marked, the question reads as the assistant's line,
never his.

## corrections.jsonl

His corrections, append-only, and the one place the owner's word is kept (with the owner's ratings: a claim the owner rated false
or partly reads as a `wrong` here, `ratings.jsonl`). A Claude session appends it when the owner says
something in conversation (`bun life memory correct '<json>'`, which checks and stamps it), and the pages step adds
`keep-mine` and `not-important` when it finds the owner editing a page file. Every rebuild respects it. Each line has
`schemaVersion: 1`, `at`, an optional `note` and:

| `kind` | Fields | Effect |
|---|---|---|
| `wrong` | `observations: [obs_…, ep_…]`, optional `page` | Never shown (pages, search; an episode: every read, and the next days' reading; its day is read again, shown it with `note`), or off that page only |
| `not-important` | `observations`, optional `page` | Same; a true fact the owner does not want |
| `outdated` | `observations: [obs_…]` | Retired by itself, as history (true then, not anymore: a promise kept, a to-do done); `note` holds his words. His fact-check `outdated` answers read as these |
| `keep-mine` | `page`, `section` (`now`, `history`; on the owner's own page also `views`, `health`; on a close person's `bond`), `text` | The line stays on the page as written |
| `this-is` | `surface`, `person: person:<id>` | A handle or name is that person (beats `truth/`) |
| `not-this-person` | `surface`, `person` | Never resolve that handle or name to that person |
| `same-person` | `from`, `to` (`person:<id>`) | Two person refs are one: `from` folds into `to` (an inferred person into a truth one) |
| `reread` | `units: [unit_…]` | Those units were read wrong (the model misjudged them; a wrong author needs none, see `speakerFrom`): its day's episodes are read again and it is extracted again, its observations replaced, when its day is next read (the night: the last 7 days; older: `backfill`). An episode filed under the wrong person needs `wrong` on its `ep_` too |
| `closeness` | `person`, `personal` and/or `work` (a level) | The owner's word on how close someone is: wins over the judged level (`closeness.jsonl`) |

## pages/people/<id>.md and pages/areas/<slug>.md (layer L3)

One Markdown page per person who has one by closeness (`pagedBy`, `closeness.ts`: the owner, `people/me.md`; anyone
whose personal or work level is inner, regular or faded and is not a service; someone not judged
yet who is in `truth/people.yaml` or has a page already, judged at the next night) and has an observation, and per area of `truth/areas.yaml` (the file is named by the
area's id; an inferred person's id starts with `inf_`). Rewritten nightly by `bun life memory pages` from the previous
version and the observations extracted since; git keeps every version (the nightly's "Memory: <date>" commits).

Frontmatter (each value is JSON, which is YAML): `schemaVersion` 1, `page` (`person:<id>` or `area:<id>`), `name`, `built` (when written),
`seen` (the newest extraction run, `madeBy.run`, the page has read), `offered` (optional: observations homed on it because who
they are about changed after they were written, a move or a fold, each given to the page once as new), `madeBy` (engine, model, prompt, run) and
`lines`: for every line Life wrote, a 10-hex hash of the line -> the observation ids it cites. A line not in `lines`
is the owner's.

Sections, in order:

- **What I hold**: quoted read-only from `truth/` (the owner's; on the owner's own page all of `truth/me.md`, the owner's goals included),
  or for an inferred person what Life guesses; never generated. An area's hold quotes its underway projects in full (each
  capped) and only counts the parked or done ones.
- **Views, values and habits** (the owner's own page only): what the owner believes and values, their philosophy, the priorities they state,
  habits and tastes, `- <text> [obs_…]`, from what the owner said in their own words (the prompt's rule: `speaker` is not yet reliable
  enough for code to check it); never ages: a line leaves when it is done, replaced, or rewritten by the owner.
- **Health** (the owner's own page only): as Now, but a line ages into History after 60 days.
- **Between us** (the page of someone close to the owner personally, now or once, `personallyClose`): what lasts between them, the
  relationship, agreements, boundaries, turning points, each view in its speaker's name; ages into History after 365
  days. `read_person_page` shows each line's first and latest evidence day. A page that loses it (a service, or the owner lowers them) moves its lines
  to History.
- **Now**: where things stand, `- <text> [obs_…, …]`. Every line cites observations and at least one is under 21 days
  old (`SECTION` in `page-format.ts`); with none it ages into History.
- **History**: `- <day> · <text> [obs_…]`, newest first, oldest last; a finished or aged line keeps its words and is
  dated by its newest observation. At most 30 lines.
- **Often talk about**: person pages (not the owner's own: the owner is in every unit), `- topic (n), …`: the topics of the verdicts of the units they are in, over 90
  days, counted by code. Not generated by the model and not in `lines`.

To-dos stay observations (their `type`): Reminders are written only by actions on the owner's clear request (`ledger.jsonl`).
`read_day` lists as due the importance-3 promises and the to-dos the owner said whose `when` is that day or up to a week before
(`dueOf`, then `openItems` in `apps/server/src/memory/open-items.ts`; the owner's choice of 20 Oct: what the owner said, not what a mail asks of the owner), with
the owner's reminders, waiting items and the replies the owner owes; an undated one shows the day after it was said and 3 days
after, then is stale, never due. It is the one place code checks `speaker`, against the rule above,
because it only narrows a list the owner reads: the owner's to-do in a voice lifelog left unnamed is missed. Rules code enforces:

- **One fact, one page.** Each observation has a home, computed on every run and never stored (`homeOf`): the person's
  page when it is about exactly one other person who has a page, else the area of its project (`Project.area`), else
  the owner's own page when it is about the owner alone (filed with them, no other person, no name Life could not map) and is a
  `about_a_person` or `preference` or has no area, else its own area. Another page may mention a fact, not repeat it.
- **No churn.** A line whose observations are all still shown stays word for word. The model may add lines for new
  observations, move a line to History, rewrite a line one of whose observations was removed or replaced, or rewrite a
  line to take in new observations while keeping its own; code rejects any other change.
- **Aging.** A Now line with no observation newer than 21 days moves to History by code (Health: 60 days).
- **800 words** per page (a close person's: 1,100; the owner's own: 2,000), hold included: the live lines with the oldest evidence move to History
  beyond that (those of a section that ages first, the owner's views last), and History loses its oldest.
- **Conflicts** are settled by extraction, where the evidence is: an episode's lines retire the earlier facts they show
  are no longer true (`supersessions.jsonl`). The owner's lines win over everything. A `conditional` observation is
  never a page line.

**The owner's edits** hold: a line the owner writes or rewrites is recorded as `keep-mine` and stays as written; a generated
line the owner deletes is recorded as `not-important` for its observations on that page.

## situations/<id>.json

Where things stand now with the owner (`me`) or someone close to him (`personallyClose`), written by `situations.ts` each
night when its inputs changed: `page` (`person:<id>`), `lines` (each `text` and `cites`, `ep_` ids of the episodes it
rests on), `inputs` (a hash of the prompt version, the page, the persona's readings and the last 30 days' episodes), `built`, `madeBy`,
`schemaVersion`. Rewritten whole, never from its own last version; removed when the person has no recent episode or
is no longer close. A reader drops a line whose episode is no longer live. His correction is a line on the page.

## personas/<id>.json

What someone with a page (`pagedNow`) is like, wants and can give, and what keeps happening between them and the owner, or the owner
himself across everyone (`me`), written by `personas.ts` from 3 years of their 1:1 chats and mail threads
(`directChats`), the group chat-days they wrote in and his recorded conversations where they spoke: `page` (`person:<id>`), `lines` (each `facet`: `traits`, `wants`, `offers`, `balance`, `reacts`, `pattern`, `approach`, or
`writes` with `writer` `owner` or `them`, `kind` null across channels, `chat` or `mail`, and `source` when one app
differs; `text`; `quotes`, each `at` and `text`, words found in a chat message or a recorded turn the call was shown, a `writes`
line's in that writer's own 1:1 chat messages, never in mail, whose text holds quoted history), `gist` (the same call's 2 or 3 sentences on what they are like, what keeps happening between them and him, and what works with them, shown first; his request of 9 Nov 2026), `inputs` (a hash of the prompt version and the
days, recordings and counts shown, not the page), `built`, `madeBy`, `schemaVersion`. Rewritten whole when its inputs changed
and it is a week old; removed when the person has no page or nothing passed between them in the last 3 years (no 1:1 or group
chat-day, no recording). Nothing is
written or removed on a night a source can't be read.

## communication-styles/<id>.json

Written until 8 Nov 2026 by `communication-styles.ts`, now part of the persona (its `writes` lines); kept, never read.

## appointments.json

What he is due at, written by `appointments.ts` each night its inputs changed (the prompt version, his day and zone,
the facts ahead it reads and the appointments held): `appointments` (each `id` `apt_…`, `title`, `start` and `end` local `YYYY-MM-DD HH:MM`,
or `YYYY-MM-DD` with `allDay` and the last day inclusive, `zone` (the place's, when not his then), `place`,
`timeGuessed`, `observations` it rests on), `inputs`, `built`, `madeBy`, `schemaVersion`. Rewritten whole; an
appointment read again keeps the id of the held one it shares the most facts with (code decides, never the model),
else its id is its facts' hash. One the reply forgets stays while its facts hold and no new one cites them. A night whose reply holds none valid keeps the last.

## appointment-events.jsonl

The calendar sync's lines (`appointments-calendar.ts`), appended outside the lock, one tick at a time:
`{schemaVersion: 1, at, appointment, calendar, event, observations, op}`, `op` `created` (its event's id in that
calendar; one written in another calendar counts as never written),
`removed` (Life deleted it, its appointment gone) or `refused` (that event gone by his hand or an agent's). No
appointment citing every fact of a refused one is written again.

## ledger.jsonl

What Life did outside itself on the owner's clear request (appended by `act`, `apps/server/src/host/act.ts`), what the owner changed in
Reminders by hand (read back by the watcher, `apps/server/src/host/inbound.ts`), and the owner's asks of his agents (`apps/server/src/host/asks.ts`):
`{schemaVersion: 1, id, at, kind, instruction?: {ref, quote, at}, why, target, before?, after, result, error?, via, timing?}`.

- `id`: `entry_` + 12 hex of SHA-1 over `ref | kind | normalized title` (an ask: its `after.title`, which is none now; a split hashed its
  parent's id instead of `ref`): the same words act or ask once; a failed try may rerun.
- `instruction`: the owner's words; `ref` is a lifelog `jobId:turnIndex@at` (for an ask, its wake turn), `session:<at>` (`bun life
  act` or `ask`) or `connector:<at>` (an ask the agent recorded from a chat, before 2 Nov 2026) or an observation's id (an add of the
  standing grant: the owner's quote and when the owner said it). `at`: when the owner said it.
- `kind`: `add`, `edit`, `done`, `remove`, `undone` (ticked back open), `restore` (back from Recently Deleted), `import` (a reminder
  Life links with no change: the first sync's baseline, fields it learns, its own add whose answer was lost), `ask`, `grant` (the standing grant on or off, `after.on`, `target` `grant`,
  the owner's words in `instruction`; the latest one stands). An ask's old lines (`TASK_LINES`), written until 2 Nov 2026 and only parsed now,
  have no `instruction` and the ask's id as `target`: `update` (the agent: `after` is the update, `state` working, waiting-owner, done or dropped, with `deadline`, `note`, `on`, `question`, `outcome`,
  `reason`, `steps` [{title, done}], `taken`), `reply` (what the agent told the owner: `after.text`,
  clipped at 4,000 characters; one on no ask has `target` `chat`) and, until 20 Oct, `nudge` (Life: `after.why`) and `steer` (the owner's change to the agent's list item, `after.changes` and `note`). Id: `entry_` + 12 hex over
  `<task>@<at> | kind` (a reply's also over its text).
- `target`: `reminder:<numericId>` or `gtask:<list>/<task>` (the actions backend's item), `reminder:new` or `gtask:new` (a failed add), `AGENT_WORD` (an ask), an ask's id (its old lines) or `chat`
  (a reply on no ask).
  `before` / `after`: the reminder's fields before, and what was written; never a transcript. An add's `after.link` is
  the reminder's deepLink UUID (it finds it after a move); a line read from Reminders may carry `created`, `deleted`,
  `lost` (gone from the owner's lists and not in Recently Deleted: purged, or on a shared list) and, in `before`, the old
  `id` of a reminder whose move gave it a new one. An ask's
  `after`: `agent` (the agent it is for, a key of the `agents` setting), `confidence` (`high`: lifelog says the owner spoke, or a session; `low`: no speaker, or the owner's own wake misheard as a name), and for speech `conversation`
  and `turns` (the turn numbers when it was heard; a late upload can move them, so `fetch` takes the `ref`, and the
  event carries only that); on an ask the agent recorded before 2 Nov 2026, `title` and, for a split, `parent` (the ask it came from, whose `instruction` it repeats). A heard
  ask's `timing`: `ended` (the owner's last turn of it ended) and `arrived` (lifelog's feed had brought all of it); with
  `instruction.at` and `at` it is what `bun life asks` lists.
- `result`: `ok` (`error: "partial: …"` when a private field failed; always for an ask), `failed` (alerted at once),
  `duplicate` (an open reminder had the title; nothing written) or `intent` (written by `act` just before a Reminders
  write, with the same `id` as the outcome line after it: a value it tried is Life's, never the owner's). `via`: `session`
  (a Claude session), `connector` (the agent's chats, updates and replies, until 2 Nov 2026), `watch` (the watcher: a `hey <agent>` heard; a
  nudge or a steer until 20 Oct) or `reminders` (the owner's own change in Reminders, with no `instruction`: state, never the owner's
  words). Intents and imports are left out
  of `read_day`'s and the nightly's Actions and of the change feed.
- Lines from before 19 Oct also have `kind` `instinct` (an email, `target` `mailto:<address>`), `timing` with `heard`,
  `modelMs` and `actMs`, and a model as `via`; they still parse.

## statements.jsonl

The fact checks: the claims the owner is asked about, one per claim, append-only, written by
`drawDoubtful` (Life's fact checks, `memory/fact-checks.ts`, at the night's run; by hand `bun life memory doubtful <n>`):
`{schemaVersion: 1, ref, text, group, kind, source, date, units, at}` (`ref`: the observation's or episode's id). Code draws them (`doubtful`, `apps/server/src/memory/statements.ts`),
no model, from `claimsNow`, the words the eval judges too: an active observation eligible for a line on its home page
(importance 2 or more, not conditional, not hidden there) in its own `text` (and `(for <when>)`); an episode as
`<title>, <when>, at <place>; with <people>.` `group` is where the owner is asked
about it: that home page (`homeOf`), or for an episode the one person with a page it was with, else `episodes`. The record is frozen (what the owner was shown, and where), so it copies what it needs:
`kind` (`fact`, `plan`, `reported`: the observation's `modality`, none before `memory-extract.v3` read as `fact`; or
`episode`), `source` (its channel; null for an episode), `date` (the claim's day) and `units` (what it was read from:
where a later run's claims about the same thing are). Only doubtful claims are drawn (`doubtsOf`: who it is about is
only inferred, `guessed-person`; and `low-confidence`, under `SURE_AT`, only beside it), importance 3 before 2
(never 1), then the most doubts, then the newest. An episode is never drawn: neither doubt is an episode's. Statements drawn
before 29 Oct 2026 were a random spread.

## ratings.jsonl

The owner's answers to the fact checks, append-only, written by `recordRating` (his answer to a fact check in a chat, `correct_memory` `fact_check`; his decisions-page tap before 8 Nov 2026, his fact-check loop before 30 Oct, and the check page before 29 Oct; by hand `bun life memory rate <ref> <answer> [why]`): `{schemaVersion: 1, ref, answer,
at, note?}`, `answer` `true`, `false`, `partly` (from 29 Oct), `outdated` (true when Life recorded it, not anymore),
`skip` or null (the owner took their last answer back); `note` his why, in his words. Only a statement he was shown can be
rated. What each answer means is one table (`ANSWERS`, `ledger.ts`). The latest line for a claim is the owner's answer. A `false` hides the claim as a `wrong` correction would
(`readCorrections` adds it, note `rated false` and his why), so an undo or a later `true` lifts it; a `partly` does the
same (note `rated partly: <his why>`) and the eval leaves it out, like a `skip`; a `true` confirms it, but never
lifts a `wrong` the owner said in conversation (`corrections.jsonl`). An `outdated` reads as an `outdated` correction
(`readCorrections` adds it, note `rated outdated`), which retires the claim by itself (`outdatedBy`, `validTo` the answer's UTC day), after extraction's own; on an
episode it changes nothing. A skipped statement is not asked again.

## scores.jsonl

How the memory scored against the owner's ratings, one line per run of `bun scripts/eval.ts --ratings` with something to judge,
append-only: `{schemaVersion: 1, run, at, rated, trues, held, missed, contradicted, restated, both, ungraded, outdated, gone}`: of `rated`
statements judged (`trues` of them true), each as of its own day (against the claims said by then), `held` true ones the memory still states, `missed` true ones it no longer states, `contradicted` true ones it
contradicts, `restated` false ones it says again, `both` ones it states and contradicts (kept both: counted apart since 28 Oct 2026, before in
`contradicted` or `restated`; absent then), `ungraded` ones the judge left out; `outdated` ones (counted true and held, not judged: closures Life
missed; absent before 19 Oct); `gone` rated statements were not
judged because none of their units is live any more (a regrouped conversation, or a unit a code rule now drops).

## supersessions.jsonl

Observations a newer one replaced, written by code (the ledger is never edited): `{schemaVersion: 1, observation, by,
validTo, why, page?, madeBy, at}`. `observation` holds until `validTo` (the newer one's `validFrom`, else its day).
Retired observations leave the pages and searches; they stay in the ledger. Extraction (from `memory-extract.v3`, no
`page`) retires an earlier fact an episode's lines show is no longer true; `by` was said after it. Until 18 Oct pages
decided it (`page`; `by` outranked `observation`: later day, then written over spoken, then the owner's own words). A
retirement stands only while `by` is current: a replacement re-read away retires nothing.

## zones.jsonl

Where the owner was, as an IANA time zone, append-only: `{schemaVersion: 1, from, tz, source?}`, the zone from `from` on,
read in `from` order (the earliest also covers everything before it). Every local day and time in memory/ comes from it (`zoneAt`,
`apps/server/src/memory/zones.ts`), so a unit's day, and the id of a chat-day or mail thread-day, stays the same when the day is
read again from another country. The nightly tick (every 30 minutes) appends a line when where he is (`readZoneHere`:
the phone's zone from its newest heartbeat, whatever its age; the Mac's own zone, never a `TZ` variable, only when no
phone ever named one; nothing when lifelog is set up but can't be read) differs from the latest one, taking effect at once, or at the next midnight
of the zone ahead when the two are on different days (`cutAt`: a local day never goes back); what came before it was
noticed keeps the old zone. The present (`dayNow`) follows the latest line at once, even before its
`from`. `bun life init` seeds it by the same rule (both through `noteZones`, the one writer). The owner's past may be appended later (their own account of where they lived) only
before the first day memory has units of: an earlier unit's day, and so its id, would move. Historical collection derives whole-hour offsets from the owner's sent-mail Date headers as `Etc/GMT±N` with the reversed IANA sign. Missing-mail days take the nearest known run, ties earlier, and are reported as gaps; conflicts and non-hour offsets defer their days. Such a run says `source: "mail"`; a line without it is a record of where he was, and the first of those ends the mail era: only the days before it are set, deferred or gapped by mail, so a day a recorded zone covers is never deferred. No city or inferred flag is stored. Gap evidence can be re-derived from the headers for later model backfill; stored unit dates and ids remain unchanged.

## labels.jsonl

The owner's hand labels on units, appended by a Claude session when the owner says a unit matters or doesn't (see AGENTS.md); the latest line for a unit wins.
`{schemaVersion: 1, unitId, matters: boolean, type?, area?, at}`. They are the frozen evaluation set for the verdicts: a
unit "matters" to the owner or it doesn't; `type` is the right one when the owner gave it, `area` the right area (an id from `truth/areas.yaml`).

A label belongs to a unit id, so labels are only as stable as the ids. A conversation-day's id is stable per conversation
and day: when lifelog regroups a conversation, its units get new ids, and labels (and observations) on the old ones
point at units that no longer exist (the agreement figure counts them as "not in memory/units"). **Any change to
how stored unit ids are made ships an old→new id map applied to `labels.jsonl` in the same commit**; a new recipe for
new units only, every stored id kept (conversation-days beside the stored chapters), is not one.

## migrations.jsonl

The renames of stored names Life has written into this data, one line each, append-only: `{schemaVersion: 1, name,
at}`. `stored-names-2026-10-22` (`apps/server/src/host/migrate.ts`, since removed: see git history): the names of docs/glossary.md, written once by
the app at its next start (AGENTS.md, "A rename backfills"); before it, the ledger was `actions.jsonl`, ids were `u_`,
`act_` and `inf-`, the types `todo`, `waiting` and `person`, `importance` was `salience`, a ledger entry's `via` was
`madeBy`, a statement's and a rating's `ref` was `claim`, a task update's `taken` was `claim`, `waiting-owner` was
`waiting-eric`, and the agent's word was `atlas`. `observation-choice-2026-10-29` (the same file, since removed): the
observation type `decision` is `choice` (his OK, 29 Oct 2026: "decision" is his loops' questions now), each such
observation's id minted again and every citation of it rewritten. The data repo's commits
"Memory: before the stored names' rename" and "Memory: stored names renamed" hold both sides of the first, "Memory:
before the observation type's rename" and "Memory: the observation type decision is choice" of the second.
`agents-2026-10-31` (the same file, since removed): the one agent became agents by name (the settings' `agent` became `agents:
{<name>: {wake, misheard, start: {command, on}}}`, its `client` and `transport` gone); its name was stamped on every
ask (`after.agent`), every decision it asked (the `asked` line's `agent`, fact checks aside) and every paired app's
refresh record, each line in its place; "Memory: before the agent's name is stamped" and "Memory: asks and decisions
name their agent (agents-2026-10-31)" hold both sides.
`episodes-2026-11` (the same file, since removed): moments became episodes, only what happened: `memory/moments/`
became `memory/episodes/`, a line not `happened` went, `why` became `what`, ids `mom_` became `ep_` wherever cited, a
fact check's kind `moment` became `episode` and its group `events` `episodes`; "Memory: before moments become episodes" and "Memory: moments are
episodes, what happened, with what came of it (episodes-2026-11)" hold both sides.

## The search index (not in memory/)

`derived/memory/index.sqlite` is rebuilt from `observations/` and `units/` by `bun life memory index` (and by the nightly run, once, at the end):
table `observations` (with `superseded_by` and its end date in `valid_to` for retired ones, its `home` page and the
`detail` it states), full-text table
`search` (claim and quote, accent-insensitive) and table `links` (observation, entity); and the units: table `units`,
full-text table `unit_search` (title, a chapter's or repo-day's summary, verdict topics), `unit_topics` and `unit_people`. Delete it (with its
`-wal` and `-shm` files) any time. Agents read it, and the pages, through `bun life memory search|fetch|day|person|area|topics|unresolved|chats|places` (read-only).
