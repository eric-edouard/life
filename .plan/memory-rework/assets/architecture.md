# The memory's architecture (draft)

Draft of 10 Nov 2026, by the designer at his word ("think larger: we're reworking the memory from an architecture
perspective"). He can overrule any line. Words here are plain English; the names are ticket 23's and need his yes.
What he wants and why the memory exists: [00-what-he-wants.md](./00-what-he-wants.md).

## The problem

The raw data grows for ever; an agent's context does not. The memory is a structure over the raw data such that, for
any question on the grid (what happened, where it stands, what keeps repeating, what comes next; about him, a person,
a part of his life), an agent reaches a small piece that is enough to answer about as well as reading all the raw.
And it must be kept up at a cost per day that does not grow with the years, and be rebuilt under a better model
without reading the raw again.

How information reaches him (a chat, a mail, how often) is not part of it: the memory holds and serves; any reader
asks when it likes.

## The shape, in five lines

1. **One evidence log.** Everything read from the raw is written once, as small dated records close to the words:
   what happened, what was said, what was done between people, what he said he felt or intends, what code measured.
2. **One history per subject.** Each person, each part of his life and he himself has its evidence gathered and
   summarized in time: month, year, the whole story. A level exists only where the one below is too big to read whole.
3. **A summary and its tail.** A reader gets the last summary plus the evidence that came after it. So a summary need
   not be rebuilt every night to be current, and nothing recent is ever missing.
4. **Counts by code.** Meters, track records, time against goals, who is close: counted from the evidence at any span,
   never written by a model, never summarized.
5. **One overview on top**, built from where each subject stands. An agent reads down: overview, subject, span,
   evidence, raw quotes.

## The layers

| Layer | What it is | Written by | When |
|---|---|---|---|
| Raw | Sources, the archive, lifelog. The only truth | the apps | always |
| Units | A stable address for a piece of raw (a chat-day, a conversation-day); the exchange is a slice over them | code | as data lands |
| Evidence | Small dated records, each citing its messages with a checked quote, or a number code measured | a model, once per piece and per family of read; code for measures | once, when the piece is complete |
| Histories | Per subject: month, year, the whole story; where it stands now | a model, from the level just below | when a tail grows big or a span closes |
| Counted readings | Meters, patterns' counts, track records, time and money against goals, closeness, ties | code | when read |
| Forecasts | A dated expectation with the day it is checked, then its score | code first, a model where backtests show it helps | nightly |
| Overview | Where things stand across his life | a model, from the subjects' standings | when a standing changed |

Only the evidence layer ever reads the raw. Everything above is rebuilt from the layer under it.

## The evidence layer

One append-only log of small records. Each has a day, the people in it, the subjects it belongs to, and either a
quote checked against its messages or a number code measured. Its kinds:

| Kind | What it holds | Today |
|---|---|---|
| What happened | An episode: a stretch of his day that took place | episodes |
| What was said | A claim: a to-do, a promise, news, a choice, a preference, a fact about someone | observations |
| How it ended | A promise or a wait closing: kept, dropped, lapsed | missing: a line just goes stale |
| What was done | An act between people in an exchange: who asked, yielded, blamed, apologised, went silent, deleted | missing |
| What was told about someone | A mention: who is meant, who tells it, who listens | missing |
| What he says of himself | What he felt, intends, resolves, believes, in his words | partly: views; feelings are forbidden today |
| What code measured | Per exchange: who started, delays, shares, last word. Per day: hours by app, project and person, money paid, places, calls | scattered, mostly unused |

Rules:
- A record states what was said or done, not what it means. Interpretation lives above, where it is cheap to redo.
- Each family of read is its own focused prompt with its own version and cache. Adding a family later is one new
  read over the history, never a redo of the others.
- A record's id comes from where it sits in the raw (its unit, its messages, its kind), not from its wording, so a
  re-read does not orphan what cites it.
- Nothing is retired by deleting: a claim stops holding when a later record says so (as today), an act never stops
  having happened.
- His word (a correction, a rating, a told line, `truth/`) is evidence of its own kind, pinned to the raw messages
  and the subject it is about, not to a model-made id. Every build reads it and it beats any reading.

## Subjects

Three kinds: he himself, a person, a part of his life (an area, a project, a goal).

- **Everyone has a history, as deep as their evidence.** Three exchanges in ten years: the evidence itself, no
  summary. A parent: every level. So no gate decides who gets one, and closeness stops being a filter.
- **A part of his life he never declared** (a dispute, a purchase, a trip being planned, a health matter) is named by
  the day's read, kept in a model-owned list, used at once and corrected later, like unknown people today. He can
  make it a project in `truth/`. Without this, things that run for months have no home and no owner.
- **His own history** is built from his evidence (what he says of himself, his acts across everyone, what code
  measured) and from the other subjects' summaries for the same span. His month is the period of his life.
- A record can belong to several subjects (him, a person, a project). It is stored once.

## Histories: summary and tail

- A subject's month summary is read from that month's evidence, with the story so far as context to compare
  against, never as evidence. A year is read from its months, the story from its years.
- A finished month is sealed: read once, never rewritten, addressable for ever. This also gives "as things stood on
  a date", which backtests and "how did it move" need.
- Where it stands now (today's situation, for every subject) is the newest summary plus its tail: the evidence since.
  It is rebuilt when the tail holds something that matters or grows past a size, and when the month closes.
- Carried up by rule, at every level: turning points, patterns with their counts, his biography, what he marked or
  corrected, his decisions and views, what was never closed.
- Late data and his corrections reopen only the months they touch, then the levels above them.

## Counted readings

By code, from the evidence, at any span, when read:
- A meter: how often an act happens per chance to do it, per vantage (with him, with others, as told), with "too
  few to say" as a value.
- A pattern: a sequence that repeats (blames, then denies), with its count, first and last time, and quotes.
- A track record: promises kept, dropped, lapsed, each way.
- His time and money per project, area and person, against his stated order of goals.
- Closeness: depth (what is confided, support given, the personal against the practical), with his word above it.
  It ranks who shows in the overview. It gates nothing.
- Ties between other people: who appears with whom.

## Forecasts

A forecast is a record: what is expected, as of when, checked when, then scored. It starts from a base rate counted
on the evidence; a model adjusts it only for the kinds where backtests showed a gain. The same code run "as of" a
past date is the backtest. A kind of forecast is shown only once it beat its base rate.

## The write path

- **Every night** (cost follows the day's text, never the years): new units; the evidence reads for what is new;
  code measures; due forecasts scored. For each subject touched, the tail grows; a standing is rebuilt only if needed.
- **When a month closes**: its summaries are sealed for the subjects that had evidence; the years and stories above
  them are rebuilt from their children.
- **A better model**: the histories are rebuilt from the evidence. The evidence is read again only for a family a
  measured gap shows lacking.
- **Old history** (imports): the same path, once, after the prompts are frozen on the pilot. Old years with little
  evidence get no monthly level.

## The read path

An agent with limited context reads down, each step small enough to read whole:

1. **The overview**: where things stand across his life, each line pointing at a subject.
2. **A subject**: where it stands, its story, what repeats (counted), what is open, what is expected.
3. **A span** of that subject: a year, a month.
4. **The evidence** for a subject, a kind and a span, with quotes.
5. **The raw**: the messages and turns themselves.

- A subject read is ordered by the kind of question: a question about a relationship meets the relationship first,
  the logistics last.
- Search (words and meaning) covers every level, so a broad question lands on a summary and a narrow one on a quote.
- Each level has a size budget, set at the pilot.

## The boundary

The memory is one module, built so it could leave this repo one day.

- **In**: units and a way to read their words; his word; the map he writes in `truth/`; a clock and his time zone; a
  model call with its cache; the embedder.
- **Owns**: the evidence log, the histories, the forecasts, the overview, the search index.
- **Out**: the reads above, and the events agents wait for.
- **Outside it**: capture (sources, the archive, lifelog, the bridges), acting (asks, the to-do list, the ledger),
  the host (the schedule, the connector's server, the app, the mails).

## What it replaces

| Today | Becomes |
|---|---|
| Units, the archive | Unchanged |
| Episodes, verdicts | Stay: evidence of what happened |
| Observations | Stay: evidence of what was said; ids no longer follow the wording; endings recorded |
| Pages (a model rewriting prose from facts each night) | A view drawn from a subject's history |
| Situations (30 days, close people only) | "Where it stands", for every subject, on a real history |
| Personas (three years of raw re-read weekly) | Counted readings plus the story; the re-read goes |
| Closeness by volume | Depth, counted; a rank, not a gate |
| Open items, appointments, fact checks, search, the connector's reads | Stay, fed by the same evidence |

Three prose layers, each with its own window on the raw, become one mechanism. New model work: the acts, mentions
and self-reports reads, and the summaries.

## How it is judged

- Against a model reading the raw whole, wherever the raw fits one call: same question, memory only against raw.
- On his questions, a share held out of the design.
- Remove a layer and measure what it was worth.
- Forecasts against base rates, on the past.
- His blind ratings of the meters, never a target.
- The practical answers must not get worse.

## Left for later

- The memory answering a question itself (its own reads with a large-context model, returning only the answer and
  its evidence). The reads above are what it would use, so it can be added on top without changing them. It spends
  model calls at question time and changes a rule (model calls see no tools), so it needs his yes.
