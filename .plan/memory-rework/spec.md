# Life's memory: the spec

Draft of 10 Nov 2026. Written by the designer from the map's decisions; he left the shape to the designer and can
overrule any line. Plain words throughout: the names are section 16's and need his yes. Nothing here is built or run
before the pilot, and the pilot waits for his credits.

Read first: [what he wants, and where Life stands](./assets/00-what-he-wants.md).

## 1. The problem

The raw data grows for ever; an agent's context does not. With unlimited context an agent would read all the raw
and answer anything. The memory is the structure that stands in for that: for any question on the grid (what
happened, where it stands, what keeps repeating, what comes next; about him, a person, a part of his life) an agent
reaches a small piece that is enough to answer about as well as reading all the raw.

Three demands follow:
- **Read side**: the right piece is found in a few steps, each small enough to read whole.
- **Write side**: keeping it up costs what the new day costs, never what the years cost; nothing is summarized from
  its own last version.
- **Rebuild side**: a better model rebuilds it without reading the raw again.

How information flows back to him (a chat, a mail, how often) is not part of the memory. It holds and serves.

Every layer is a hypothesis: that storing this makes an agent answer better than searching the raw. It is measured
(section 14) and removed if it does not.

## 2. The shape

1. **One evidence log.** Everything read from the raw is written once, as small dated records close to the words.
2. **One history per subject**: a person, a part of his life, he himself. Summaries by month, year and the whole
   story; a level exists only where the one below is too big to read whole.
3. **A summary and its tail.** A reader gets the last summary plus the evidence that came after it.
4. **Counts by code**: meters, patterns, track records, time against goals, closeness. Never written by a model.
5. **One overview on top.** An agent reads down: overview, subject, span, evidence, raw quotes.

| Layer | What it is | Written by | When |
|---|---|---|---|
| Raw | Sources, the archive, lifelog. The only truth | the apps | always |
| Units | A stable address for a piece of raw; the exchange is a slice over them | code | as data lands |
| Evidence | Small dated records, each with a checked quote or a measured number | a model, once per piece and per family; code for measures | once the piece is complete |
| Histories | Per subject: month, year, story; where it stands now | a model, from the level just below | when a tail matters or a span closes |
| Counted readings | Meters, patterns, track records, time and money, closeness, ties | code | when read |
| Forecasts | A dated expectation, its check day, its score | code; a model where backtests show a gain | nightly |
| Overview | Where things stand across his life | a model, from the subjects' standings | when a standing changed |

Only the evidence layer reads the raw. Everything above is rebuilt from the layer under it.

## 3. Units and exchanges

- Units keep their shape and day cut: a message's day never moves, so nothing that cites a unit is orphaned.
- An exchange is one sitting of talk, cut by code, never stored twice: a slice over a unit's messages.
  - A chat or a mail thread: until a long silence (several hours, so a waking day's replies stay together and a night
    ends it; the number is set from his own message gaps at the pilot). A next-day answer opens a new exchange, marked
    by code as an answer and read with the lines before it as context.
  - A recording: lifelog's conversation, with lifelog's edges. Only assigned and matched turns are a person's own
    evidence.
  - One channel per exchange; the episode joins across channels (a call's line with what was heard).
- Read closely: every two-sided exchange, with anyone, at any age. Skipped by code: notifications, newsletters,
  messages nobody answered, big groups where he never speaks. A small group is read even when he is silent in it, if
  someone who also talks with him one to one speaks in it.
- New from the sources, by code: reactions (an answer without words) and which message a reply answers.
- His chats with an assistant are not exchanges: his own writing, read for what he says of himself and of others.

## 4. The evidence log

One append-only log. Each record has a day, who is in it, the subjects it belongs to, and either a quote checked
against its messages or a number code measured.

| Kind | What it holds | Today |
|---|---|---|
| What happened | An episode: a stretch of his day that took place | episodes |
| What was said | A claim: a to-do, a promise, news, a choice, a preference, a fact about someone | observations |
| How it ended | A promise, a wait, a plan or a choice closing: kept, dropped, lapsed, and what came of it | missing |
| What was done | An act between people in an exchange (section 5) | missing |
| What was told about someone | A mention: who is meant, who tells it, who listens | missing |
| What someone says of themselves | A feeling, an intention, a want, a belief, in their own words | partly |
| What code measured | Per exchange: who started, delays, shares, last word, left unanswered, call length. Per day: hours by app, project and person, money paid, places | scattered |
| His word | What he tells Life (section 7) | corrections, labels, told, ratings |

Rules:
- A record states what was said or done, never what it means. Meaning lives above, where it is cheap to redo.
- Each family of read is its own focused prompt, with its own version and cache. A new family later is one new read
  over the history, never a redo of the others.
- A new record's id comes from where it sits in the raw (its unit, its messages, its kind), not from its wording.
  Records stored today keep their ids.
- Nothing is deleted. A claim stops holding when a later record or his word says so; an act never stops having
  happened.
- Which families read which age: acts, mentions, self-reports, lasting claims (facts about him and people, choices,
  promises with their endings) are read at every age. The practical claims (to-dos, waits, appointments) are read
  only near now.
- A record can belong to several subjects. It is stored once.

## 5. The codebook

Four focused reads of an exchange, beside today's two (the day's read: episodes and verdicts; the claims read).
Every code names who did it, to whom, with the quote. A code that answers something records what it answered, so a
rate is counted per chance to act, and avoiding is never mistaken for absence.

| Read | Codes | The chance it needs |
|---|---|---|
| Connection | A bid (reaching out, sharing, asking for attention) and its answer: toward, away, against. Good news shared and its answer. A disclosure, with its depth. Support asked, support given, its kind. Affection or thanks. Tone: warm to cold, per side | An answer needs a bid; depth needs a disclosure |
| Conflict and steering | A complaint, specific or global. Contempt or insult. Blame, and where it is placed. The answer to a complaint: engages, excuses, denies, counters. Pressing, and pressing again. Pulling back or going silent. Appeal to one's own distress. Yielding. An apology and what it contains. A mending attempt and whether it is taken. "Let's move on", and a later reopening. Steering: directs, proposes, defers | Most need a complaint or a disagreement in the exchange; steering needs a decision at stake |
| Giving and asking | Asks for, offers, gives, refuses, returns: affection, standing, information, money, goods, a service. A promise made here is the claims read's | An ask opens the chance to give or refuse |
| Mentions and self-reports | Talk about someone absent: who is meant, teller, listener, a fact or a judgement, its tone, one act or the whole person. What someone says of themselves: feels, intends, wants, believes. Reported speech is flagged, never the reporter's own stance | None |

- The exact wording, the anchors and the examples of each code are written and frozen on the pilot.
- Whether the day's read may flag which exchanges need which read, to save calls, is tested on the pilot against
  reading all four everywhere. It is adopted only if it misses nothing that matters.
- Refused as stored labels: a type, a diagnosis, an attachment style, a verdict on a person.

## 6. Subjects, and who acts toward whom

Three kinds of subject: he himself, a person, a part of his life (an area, a project, a goal).

- Everyone has a history as deep as their evidence. No gate decides who gets one.
- A part of his life he never declared (a dispute, a purchase, a trip being planned, a health matter) is named by the
  day's read, kept in Life's list, used at once and corrected by his word.
- His own history is built from his evidence and from the other subjects' summaries for the same span. His month is
  the period of his life.

He is not one person in the data: with one person he plays a role, with another he says what he thinks. So:

- Any counted reading can be cut by counterpart: he with a parent, he with a friend, he across everyone; a parent
  with him, a parent with others.
- **How he acts with someone and what he thinks of them are two readings, never mixed.** His conduct with them comes
  from what passes between them. His view of them comes from what he tells others, tells Life and writes for
  himself. What he says to their face is never read as his view.
- The difference between the two is kept as a finding: where he performs, with whom, about what.
- A view told to a listener carries that listener's pull: it is shown with who heard it, and weighs more when
  several listeners heard the same.
- The same holds for others: what a person tells him about someone is that person's view, never the someone's own
  words.

## 7. His word, and Life's list

`truth/` goes as a folder he is supposed to write. He never wrote it; agents typed in what he said. What it was for
stays.

- **His word is what he tells Life**: in a chat with an agent, with "hey Life", in a correction, in an answer to a
  question. Said once, it holds: dated, in his words, the strongest evidence. It is pinned to the raw messages and
  the subject it is about, never to a model-made id, so every rebuild reads it and no re-read loses it.
- **What he says to other people is not his word.** It is evidence about him.
- **Life's list** holds the subjects: people, parts of his life, his goals in order. Life fills it from the evidence,
  uses it at once, and his word corrects it. The fields code computes with (handles, repos, a birthday) are entries
  of it. What `truth/` holds today is its seed, kept as his word.
- **The declared side**: his vision, his goals in order, how he plans to reach each, who people are to him. It is
  what the observer measures his actions against. It moves only when he tells Life: a remark heard in passing is
  kept as "heard, not confirmed" and becomes a question.
- **Kept current three ways, none waiting on him**:
  1. Heard: what he says he wants or plans, anywhere, is evidence; Life drafts from it, marked as its understanding.
  2. Asked in context: Life works out the questions it has for him, each tied to a subject (a goal with no plan, a
     goal his time contradicts, a person whose place is unknown, a matter that may be over, a doubtful claim). An
     agent talking with him about that subject gets them and can ask there.
  3. A sitting when he wants one: the open questions, the ones whose answer changes the most first.
- **A new Life starts with an interview** (his word, 10 Nov): there is something to seed. An agent asks the person
  what they want out of life: their goals and objectives, and how they plan to get there; then the parts of their
  life and the people who matter. The answers are his word and the first entries of the list. It is the same
  sitting as above, on an empty list; for him the seed is what `truth/` holds, and the sitting fills what it lacks
  (the plan for each goal, his vision).
- Questions are worked out from what is stored, never kept as a queue. An answered one does not return; "I don't
  care" is an answer.

This changes rules of `AGENTS.md` (only the owner writes `truth/`; his goals live there only; a new key lands in
code first). They are rewritten with the build, on his yes.

## 8. Histories: summary and tail

- A month's summary is read from that month's evidence for the subject, with the story so far as context to compare
  against, never as evidence. A year is read from its months, the story from its years.
- A finished month is sealed: read once, addressable for ever. That gives "as things stood on a date".
- **Where it stands** (today's situation, now for every subject) is the newest summary plus its tail. It is rebuilt
  when the tail holds something that matters or grows past a size, and when a month closes. It says where the
  subject stands, what moved, what blocks it, and whether the latest repeats a known pattern or breaks it.
- For a part of his life, a standing also carries a word set by code from the evidence: moving, waiting on someone,
  stuck, drifting, dormant, done.
- Carried up by rule at every level: turning points, patterns with their counts, the facts of his biography, what he
  marked or corrected, his decisions and views, what was never closed.
- Named periods and turning points are a view on top; no id depends on where a period starts.
- Late data and his corrections reopen only the months they touch, then the levels above.
- A summary line cites the evidence it rests on. A line with no evidence left is dropped by the reader.

## 9. Counted readings

By code, from the evidence, at any span, when read. Never stored as a verdict.

**How a meter is counted**
- A rate: how often the act happened per chance to do it, in one vantage: with him, with others, as he tells it, as
  others tell it. Vantages are never blended.
- Shown as a band with how many chances it rests on. Below a minimum, it reads "too few to say".
- Never pulled to the middle: no averaging toward a typical person. Beside how often, a meter keeps how far at its
  strongest, with the quote, so one extreme is not washed out by many mild days.
- Lately against before: the last year against the years before, and the month where it changed.
- A role is named when it explains the reading (a parent directing a child, a client).
- A trait reads the person's own conduct, never what they demand of others.

**A persona** (today's word, kept) is what a person is like, as a view over these readings: their trait meters,
their conduct lines, their patterns, what they want and offer, how they write, and a short gist. His own persona is
the same, cut by counterpart.

**Trait meters about a person**: the Big Five at the level of its ten aspects, plus Honesty-Humility. Each is counted
from coded acts, never rated in one go.

| Meter (poles need his words) | Accepted construct | How well text carries it |
|---|---|---|
| Outgoing or reserved | Extraversion: enthusiasm | Well |
| Takes the lead or goes along | Extraversion: assertiveness | Well |
| Warm or matter-of-fact | Agreeableness: compassion | Well |
| Tactful or blunt when disagreeing | Agreeableness: politeness | Fairly; needs disagreements |
| Does what they said or drops it | Conscientiousness: industriousness | Well; checkable later |
| Planned or improvised | Conscientiousness: orderliness | Fairly; own conduct only |
| Even-tempered or quick to anger | Neuroticism: volatility | Fairly |
| Worries aloud or not | Neuroticism: withdrawal | Poorly: an inner state, shown only as what is said |
| Curious for ideas or practical | Openness: intellect | Fairly to well |
| Drawn to beauty and novelty or not | Openness: openness | Poorly from chats; shown when evidence allows |
| Fair or takes more than gives | HEXACO Honesty-Humility | Fairly; counts and quotes only |
| Sure of the bond or needs reassurance | Attachment anxiety, as behaviour only | Poorly to fairly |
| Shares feelings or keeps them private | Attachment avoidance, as behaviour only | Fairly |

- **The Big Five profile of a person can be drawn**: five scales, each from its two aspects, with the Honesty line
  beside it. Where an aspect is poorly seen the scale says so instead of guessing.
- Honest about accuracy: a model rating a trait straight from text agrees with the person's own questionnaire about
  as well as a stranger would. Counting many coded acts is the route the research backs, and the pilot measures what
  it reaches. And each person is seen mostly through him: a reading "with him" is partly about the two of them.

**Conduct lines about a person**: what he asked for by name, kept as counted acts with quotes, never as a trait
score, because no validated meter exists for them: defensive or engages when faulted; blames or owns a fault; an
apology's parts; whether a mending holds (the same complaint coming back); lets the past go or reopens it; needs
control or lets things be. Impulsivity is his ask and the research did not cover it: one short research note before
the pilot (the accepted model has several distinct parts), until then a conduct line (acts then reverses, sends then
deletes, how fast it escalates).

**How each writes** (today's communication style) stays in the persona: how he writes to them and they to him, with
quotes, for an agent drafting for him. It is read from a sample of their messages and rebuilt rarely: the one read
above the evidence that looks at raw words, because style is in the words.

**The dynamics between him and a person**, each direction, his part always:

| Meter | Accepted construct |
|---|---|
| Bids met or ignored | Bids and turning toward (Gottman) |
| Attuned or dismissive when something is shared | Perceived responsiveness; responses to good news |
| Warmth each way, and whether it is returned | The interpersonal circle: affiliation |
| Who steers | The interpersonal circle: control; a role is named when it explains it |
| Who reaches out | Initiation, counted |
| Who carries the effort | Shares and delays against the pair's own usual |
| How personal each gets | The intimacy process: disclosure |
| How often it turns tense, and how | Conflict moves |
| Who presses and who pulls back | Demand and withdraw, inside conflicts only |
| How fast it mends, who mends first, whether it holds | Repair |
| Mixed tone | Ambivalence, for family mostly |
| Growing closer or drifting | The trend of contact and of the personal share |

Every one can be read for a span (how it was in a given year), lately against before, and by channel.

**Patterns**: a sequence that repeats (blames, then denies it; he apologises within minutes), with its count, its
first and last time, when it happens, and quotes. Each later case is tallied: held or broke.

**Track record**: promises, plans and waits by how they ended, each way.

**Wants and offers, four directions**: what they ask and are given, by him and by others; what he asks of them and
gives them; by kind (affection, standing, information, money, goods, a service). Shown as asked, given, said. A want
nobody stated is written only in the story, marked as inferred, with what it rests on.

**His time and money**: hours and spend per project, area and person per week, from commits, Screen Time, episodes,
voice minutes and payments, set against his declared order of goals.

**About him**: the same meters, cut by counterpart and across everyone; where he performs; what he resolves against
what he then does; how he says he feels over time, by person and by activity; his routines (the same place, person or
hour again and again). A line about him is written only when it is counted over enough cases in more than one
setting; otherwise "too few to say".

**Closeness**: depth, not volume or time: what is confided each way, support exchanged, the personal against the
practical, years known; personal and work kept apart; his word above it. It ranks who shows in the overview and in a
call's context. It gates nothing.

**Ties between other people**: who appears with whom, from shared episodes and groups.

**Where this departs from the research, by his decisions**
- The research shrinks a thin reading toward a typical person. He decided a meter is never pulled to the middle.
  So nothing is shrunk: a thin reading says "too few to say", and a meter shows how far at its strongest.
- The research wants about two hundred exchanges labelled by him as the yardstick for the codes. He labels no single
  exchange. The codes are checked against a stronger model and by forecasts, and the meters by his blind ratings.
  What that leaves open: a mistake both models share stays invisible. It is written here so nobody forgets it.

## 10. Forecasts

- A forecast is a record: what is expected, about whom, as of when, checked when, what happened, its score.
- Kinds: who reaches out next and when; a promise kept; a plan followed; a bid answered; how a conflict ends; a
  pattern recurring; a relationship warming, cooling or drifting; his own usual move, and what follows if he does
  nothing; a project moving or stalling; a deadline met.
- Horizons: days to three weeks, and three to twelve weeks. Beyond that, only trends.
- Each starts from a base rate counted on the evidence. A model adjusts it only for the kinds where backtests showed
  a gain, and never gives a free number.
- The same code run "as of" a past date is the backtest. A kind is shown only once it beat its base rate.
- An agent may ask a free question; it is turned into a closed set of outcomes, logged and scored apart, so untested
  kinds borrow no credit.
- **The loop closes by itself**: what happened is new evidence, so every count and pattern moves; each kind is
  recalibrated from its score; a run of misses about a subject reopens its standing and marks a possible turning
  point. A forecast he acted on is marked. A forecast is never evidence of itself.

## 11. The write path

- **Every night**: new units; the evidence reads for what is new; code measures; due forecasts checked and scored.
  For each subject touched the tail grows; a standing is rebuilt only if needed; the overview if a standing changed.
- **When a month closes**: its summaries are sealed for the subjects with evidence; the years and stories above are
  rebuilt from their children.
- **A better model**: histories are rebuilt from the evidence. The evidence is read again only for a family a
  measured gap shows lacking.
- **Old history**: the same path, once, after the prompts are frozen on the pilot, on Codex (the old WhatsApp
  history on OpenRouter's DeepSeek after a cost estimate he approves).

What each result is kept under, and what makes it stale:

| Result | Kept under | Read again when |
|---|---|---|
| An evidence read | The exchange's or day's text, the family's prompt version | The text changed (a late or deleted message); the family's prompt changed, on his yes |
| A measure | Nothing: computed | Never stored |
| A month's summary | Subject, month, its evidence, the prompt version | Its evidence changed; his word touched it |
| A year, a story | Its children | A child changed |
| A standing | The newest summary and the tail | The tail matters or grew |
| A forecast | Its facts as of its day | Never: scored once |

## 12. The read path

1. **The overview**: his seven areas (areas and projects, practical, relationships, goals, vision, psych, meta), each
   line pointing at a subject. One screen per area at most.
2. **A subject**: where it stands, its story, what repeats (counted), what is open, what is expected, the questions
   Life has about it.
3. **A span** of that subject: a year, a month.
4. **The evidence** for a subject, a kind and a span, with quotes.
5. **The raw**: the messages and turns.

- A subject read is ordered by the kind of question: a question about a relationship meets the relationship first,
  the logistics last. The connector's descriptions say which read answers which kind.
- Search (words and meaning) covers every level: a broad question lands on a summary, a narrow one on a quote.
- Readings reach agents as data; a page is a view drawn from it.
- Each level has a size budget, set at the pilot.
- The connector's reads change in one batch: three added (the overview, a span, the evidence), the person and area
  reads returning the new content under their present names.

## 13. The boundary

The memory is one module, built so it could leave this repo.

- **In**: units and a way to read their words; his word; a clock and his time zone; a model call with its cache;
  the embedder.
- **Owns**: the evidence log, Life's list, the histories, the forecasts, the overview, the search index.
- **Out**: the reads of section 12, the questions for him, the events agents wait for.
- **Outside**: capture (sources, the archive, lifelog, the bridges), acting (asks, the to-do list, the ledger), the
  host (the schedule, the connector's server, the app, the mails).
- The check fails any import that crosses it the wrong way, as it does for today's layers.

## 14. How it is judged

Each layer states what it claims and what would refute it, before anything runs.

- **Against the raw read whole**: wherever the raw fits one call (a person, a month), the same question is answered
  from memory only and from the raw; the memory must not answer worse.
- **On his questions**: a development share to design with, a held-out share only to judge.
- **Remove a layer** and measure what it was worth.
- **Codes**: checked against a stronger model (Codex Sol) on a sample; the same exchange coded several times must
  agree.
- **Meters**: his blind rating, once per round, never a target.
- **Forecasts**: against base rates, on the past.
- **The practical answers** must not get worse; every regression case keeps passing.
- A layer that fails is reworked or dropped, and the failure is written down beside the successes.

## 15. From today to this

| Today | Becomes |
|---|---|
| Units, the archive | Unchanged |
| Episodes, verdicts | Stay: what happened |
| Observations | Stay: what was said; endings recorded; stored ids kept |
| Pages (a model rewriting prose nightly) | A view drawn from a subject's history |
| Situations (30 days, close people) | The standing, for every subject |
| Personas (three years of raw, re-read weekly) | Stay, as a view over the counted readings and the story; the weekly re-read goes, how each writes stays |
| Closeness by volume | Depth, counted; a rank, not a gate |
| `truth/` | Life's list and his word |
| Fact checks | The questions Life has for him |
| Open items, appointments, search, the connector, the mails | Stay, fed by the same evidence |

- Every feature he has today stays (the checklist of ticket 01).
- The new layers are built beside the old, in new files. A reader switches to a new layer when it passed its checks;
  the old prose layer then stops being written. Nothing of `memory/` is wiped.
- His ratings and corrections keep pointing at what they cite; the frozen voice chapters stay; the ledger is not the
  memory's and is untouched.
- The running Life never stops.

## 16. Names, for his yes

Each with what it is and is not. Today's words are kept where they fit.

| Word | What it is | What it is not |
|---|---|---|
| evidence | One small dated record read or measured from the raw | A summary, a meaning |
| act | Something one person did toward another in an exchange, quoted | A trait, a verdict |
| mention | Talk about someone absent, with teller and listener | That person's own words |
| ending | How a promise, a wait, a plan or a choice closed | A new claim |
| exchange | One sitting of talk, cut by code | A unit, an episode |
| subject | Who or what a history is about: him, a person, a part of his life | A topic, a place |
| matter | A part of his life Life named because he never declared it | A project he declared |
| history | A subject's summaries in time: month, year, story | A page (the view) |
| tail | The evidence that came after the last summary | A summary |
| situation | Where a subject stands now (today's word, widened to every subject) | A page section |
| persona | What a person is like, as a view over the counted readings (today's word) | A page, a stored verdict |
| meter | A counted rate between two poles, in one vantage | A score, a type |
| vantage | Whose conduct toward whom, or whose telling, a reading rests on | A source |
| pattern | A sequence that repeats, with its count | A trait |
| track record | Promises and plans by how they ended | A meter |
| forecast | A dated expectation that gets checked and scored | Advice |
| overview | Where things stand across his life | A page, a mail |
| his word | What he tells Life | What he says to others |
| map | Life's list of subjects (today's word, now holding what `truth/` held) | Files he writes |
| question | Something Life needs from him, asked in conversation (widens the fact check) | A queue, a task |

## 17. Decided later, by design

- **The model for each read**: on the pilot's evidence, with the backfill's cost shown, on his yes.
- **The numbers**: the silence that ends an exchange, what a big group is, each level's size, each meter's minimum.
  Set from his data at the pilot.
- **The wording of each code**: frozen on the pilot.
- **MBTI**: later, computed from the meters, as an interpretation only.
- **The memory answering a question itself**, with its own large-context model: the reads above are what it would
  use, so it can be added on top. It spends at question time and changes a rule, so it needs his yes.

## 18. The pilot

After this spec, once his credits are back; never before.

- Two people in full, at every age of the data: his father and a close friend. And he himself, for the same spans.
- Every layer at once: the evidence reads, the histories, the counted readings, the overview, a first set of
  forecasts scored on the past.
- It freezes the prompts and sets the numbers of section 17, runs the checks of section 14, and prices the backfill.
- Then: the build plan (a golden-rule plan), the build, the backfill.
