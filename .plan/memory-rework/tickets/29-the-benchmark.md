---
type: grilling
blocked_by: []
---

# The benchmark: a made-up life with known answers

## His ask (10 Nov)

A proper benchmark tool for the memory layer: a good seed of data that is not his but relates to his in function;
tests of different kinds added to it, among them from the MCP agents' side; and a check that the answers contain
the information we want. "This is how we rate models, right?"

## What exists today (checked in the code, 10 Nov)

- `scripts/bench.ts` rates models, but on his own hand-checked days, and only on facts and the timeline.
- `scripts/demo.ts` writes a made-up week of memory for the README. It is memory already made, not raw data, and
  nothing reads it as a test.
- `sources/store-fixtures.ts` builds small made-up app stores for unit tests.
- `scripts/memory-pilot.ts` (life PR 415) runs a read on his real chats. It is the runner a benchmark needs too.

So no seed of raw data over years exists, none with planted answers, and nothing asks from an agent's side.

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
