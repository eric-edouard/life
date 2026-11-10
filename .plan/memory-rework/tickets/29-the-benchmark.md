---
type: grilling
blocked_by: []
---

# The benchmark: a made-up life with known answers

## His ask (10 Nov)

A proper benchmark tool for the memory layer: a good seed of data that is not his but relates to his in function;
tests of different kinds added to it, among them from the MCP agents' side; and a check that the answers contain
the information we want. "This is how we rate models, right?"

His second word, the same day: whenever he talks with an agent and sees it does not answer as he would want, or
cannot easily reach information it should, he must be able to make a new test case easily, while the system is
being amended.

So adding a case has to be nearly free, and said in conversation: he never writes a file. Life already has the
start of this loop (when he says something did not work, it is audited and its fix carries a regression case, kept
in his data repo). The benchmark widens it:
- **One harness, two sets of cases.** The made-up life's cases live in the repo. His own cases, on his real data,
  live in his data repo, as his regression cases and his question set do today. The same run answers both; only
  the data differs.
- **A case is small**: the question as he asked it, what the answer must hold, what it must not say, and whether
  the agent has only the connector.
- **From a failure to a case**: he says what was wrong and what the answer should have held. The agent writes his
  case on his data, in his words. When the failure shows a kind of question the made-up life cannot ask yet, the
  same kind is planted in the script and asked there too, with no fact of his.

## What exists today (checked in the code, 10 Nov)

- `scripts/bench.ts` rates models, but on his own hand-checked days, and only on facts and the timeline.
- `scripts/demo.ts` writes a made-up week of memory for the README. It is memory already made, not raw data, and
  nothing reads it as a test.
- `sources/store-fixtures.ts` builds small made-up app stores for unit tests.
- `scripts/memory-pilot.ts` (life PR 415) runs a read on his real chats. It is the runner a benchmark needs too.

So no seed of raw data over years exists, none with planted answers, and nothing asks from an agent's side.

## Decided (10 Nov, his third word): the benchmark is personal, on his real data

He weighed it: a made-up life as large and as real as his own is not feasible, and a clean one would teach the
wrong lessons. So the benchmark runs on his real data, lives in his data repo, and is never pushed to the public
repo. The designer agrees, for three reasons: realism is the whole point and only his data has it; his data is
where production runs; and the truth it needs can come from elsewhere than a script.

**Where the truth comes from, strongest first**
1. **What code counts on the raw**: who reaches out, reply delays, deletions, a payment after a promise. Exact, no
   model.
2. **His word**: the cases he settled, his corrections, his fact-check answers, his verdicts. Few at first, and it
   grows every time a failure becomes a case.
3. **A strong model reading the raw whole**, where it fits one call. Labelled as a model's truth, spot-checked by
   him, never mixed with the first two.

**What it is**
- **Cases, in his data repo**, beside his regression cases and his question set (about 400 questions already say
  what a right answer holds; 25 are marked failed). A case: the question in his words, what the answer must hold,
  what it must not say, where its truth comes from.
- **Asked from the agent's side**: an agent with only Life's connector answers each case.
- **Checked**: a count by code where the truth is a count; a judge where the answer must hold something, the judge
  first measured on his own verdicts.
- **One number per cell of the grid**, his own questions apart from the mined ones.
- **The harness is code in the repo; the cases and every result stay in his data.** As `scripts/cases-check.ts`
  already reads his cases without holding any.

**What a made-up life shrinks to**: the small made-up chats the code's own tests need, as the repo already asks.
Not a benchmark.

**What is lost, plainly**: a truth no model touched for the subtle readings, and a benchmark others could run. The
first is covered in part by his verdicts and by two model families having to agree; the second waits until someone
else runs Life.

**What it does to the plan**: the benchmark and the pilot stop being two things. The pilot is the first run of the
benchmark on his data. Order: the cases and the agent-side run, then today's Life as the baseline (the 25 known
failures should fail), then each new layer against it.

## The made-up life, as first proposed (kept for the record; not built)

## Why it is the right foundation

- **The answers are known before any model reads.** The made-up life is written from a script of what happens: who
  blames and then denies, who keeps promises, when a bond turned, what he says to someone against what he says
  about them. The answer key is that script, not a model's reading. This answers the first review's main flaw (the
  pilot could not fail; a model had written most of the answer key) better than anything in the spec's section 15.
- **It is not his.** It lives in the repo, anyone runs it, and it serves Life packaged for others.
- **It tests the whole chain.** An agent that has only Life's connector over the made-up life is asked a question;
  the answer must contain what the key says. That tests the read path, not only the layers.
- **Every later change shows its number**: a model, a prompt's wording, a step of the path.

## Its limits, stated

- A made-up life is cleaner than a real one: a model writes a pattern more legibly than life does. So it comes
  before the pilot on his real data and his own verdicts, never instead of them. Made-up gives truth; real gives
  realism.
- Writing the seed is a model spend, once, and the script of that life is the real design work.

## First shape (the designer's, to settle)

1. **The script**: a made-up owner and about ten people whose roles mirror his in function, never in fact: a
   parent with hard patterns, a close friend seen rarely who disappears for stretches, a partner, a work contact
   with much volume and little closeness, a group, a landlord, newsletters. Three years, two languages, the noise of
   real chats (logistics, gaps, deletions, a source down for a week). Each planted truth is a line of the script
   with its count and its dates.
2. **The seed**: the script turned into raw messages, mail and a few recordings, written once by a model and kept
   as data in the repo; loaded as made-up app stores, so the real pipeline reads it unchanged.
3. **The tests**: questions by cell of the grid (what happened, where it stands, what repeats, what comes next; a
   person, a part of his life, him), each with what the answer must hold, taken from the script. Some are counts
   code checks exactly; some are judged.
4. **The harness**: the pipeline run on a copy of the seed, the connector served over it, an agent asked each
   question with only the connector, its answer checked. One number per cell.
5. **The baseline**: today's Life on it, first. Then each new layer against that.

## Where it sits in the path

Before the pilot. The reads are iterated on the benchmark, where the truth is known and no verdict of his is
needed; the pilot on his data then checks that it holds on a real life.
