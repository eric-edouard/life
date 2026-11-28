# What the system really does

Read `docs/design/2026-11-28-turn-by-turn-v3/2026-11-28-real-flow.md` before drawing timing or states. Open its
section, not the whole file:

- "Measured timings": a typed ask answers in about 15 s (p90 36 s); a read of Life is fast, the model's thinking is
  slow; "hey Life" reaches the Mac in about 77 s; an agent's draft card in about a minute.
- "What the phone receives while it works": six lines only (`thinking`, `step`, `words`, `block`, `reaction`,
  `answer`), from `apps/server/src/records/main-session-wire.ts`. A state the wire can't carry is a proposal.
- "What is instant, and what needs a turn": the count's tap and the pendant are code, never a model turn.
- "Decided (28 Nov 2026)" and "Still open".

Rules from it: one quiet step line while Life works; a question about a message an agent already drafted a reply to
brings that card, Send one tap away; Life never speaks aloud; every ask gets a reply (`docs/product.md`, rule 10).
