# Fact checks: doubtful facts to the owner, the check page retired

The owner corrects the facts Life is least sure of, a few a day, from the Decisions page's cards (a life-loops
objective loop, `objectives/facts.md`, its own PR), instead of rating random statements on `/check`. This PR is
Life's side: which facts are doubtful, the two commands the loop runs on the Mac, "partly" with his why, and the
check page deleted.

Decided with the owner (29 Oct 2026): the cards live on the Decisions page; the loop reads Life with `bun life` on the
Mac, so the connector's tools stay frozen; about 5 a day.

## Milestone 1: doubt, by rules

- [ ] `doubtsOf(claim)` (pure, `memory/statements.ts`): the reasons a claim is doubtful, each a fixed word, from what
  is stored today:
  - `guessed-person`: an `inf_` ref in the observation's `about` or `entities` (who it's about is only inferred);
  - `unsure-moment`: an observation read from a unit of a moment with `status: "unsure"` (one set of those units,
    built inside `claimsNow`; a moment claim itself never: an unsure moment has no home group, `momentGroup`);
  - `low-confidence`: `confidence` below `SURE_AT` (`memory/observe.ts`, the one "the model was unsure" rule),
    counted only with another reason.
  No reason, not doubtful. #251's disagreements and contradictions add words here later, nowhere else.
- [ ] `Claim` carries what ranking needs (`importance`, `doubts`) from `claimsNow`, the one place a claim is made.
- [ ] `doubtful(claims, stated, n)` (pure): importance 3 then 2 (1 never), then more reasons, then newest; claims
  already stated or without a home group are left out. Replaces `spread` and `roundRobin`.

## Milestone 2: the two commands

- [ ] `bun life memory doubtful <n>` (replaces `statements <n>`, `addStatements`; its run keeps the stored name
  `memory.statements`): under the lock, draws `n`, appends
  them to `statements.jsonl` frozen as shown (unchanged record), prints them as JSON with `doubts`, the quote and its
  source, so the loop writes the card from that alone.
- [ ] `bun life memory rate <ref> <answer> [note]`: appends one `ratings.jsonl` line (his single line, no lock, as
  today); refuses a ref not in `statements.jsonl` (the check page's rule, moved).
- [ ] `Rating`: `answer` adds `partly`; optional `note` (his words). Additive, no migration.
- [ ] What each answer does, decided once: one table in `ledger.ts` from answer to its correction kind (or none),
  replacing `ratedFalse` and `ratedOutdated`, and read by `ratedFacts` too, which today grades anything not
  `false` as true:
  - `true`: confirms (as today);
  - `false`: hidden (as today), his note as the correction's note;
  - `partly`: hidden like `false`, note `rated partly: <his words>`, so a half-wrong fact stops being stated. His
    words feeding extraction is a prompt change, out of this PR (below).
  - `outdated`, `skip`, null: as today.
- [ ] `read_memory_changes` gains `rating.partly` (a new value of an existing type field, no tool change);
  `docs/status-reads.md`.

## Milestone 3: delete the check page

- [ ] `host/http/check-page.ts` and its test, `assets/check/`, its route in `server.ts`.
- [ ] `createSignIn` and `SignIn` (`signin.ts`) and their test: only `/check` used them. `localKey` and
  `keyRefusal` stay (the CLI and the server use them); the file is renamed for what is left (`local-key.ts`), its
  importers (`cli.ts`, `server.ts`) follow. Then dead: `SESSION` (`http.ts`) and `redirect`'s 307 argument.
  `server.test.ts`'s `/check` cases go; the comments in `server.ts` and `http.ts` name `/me` only. The brand route
  stays (his agent's pages use it), its comment changes.
- [ ] `PAGES_CLIENT` and its branch in `oauth.ts`: Life's own pages' client was `/check` alone.
- [ ] Docs: AGENTS.md ("doubtful is decided only in `doubtsOf`, from derived values, never stored"; the one exception: "the fact-check cards, answered when he likes, never waited on"; the
  pages invariant names `/me` only; `/check` out of the pairing line), `docs/architecture.md` (the check page
  section, `signin.ts` at :167), `docs/glossary.md` ("the check" replaced by a "fact check" line), `docs/SCHEMA.md` (statements written by `doubtful`,
  ratings by `rate`, `partly` and `note`), `docs/brand.md`, `docs/use/connect.md`, `docs/operations.md`,
  `docs/tasks.md`.
- [ ] SECURITY.md, "What leaves the Mac": the facts and quotes the fact-check loop asks about, on his private
  Decisions page (his OK of 29 Oct).

## Not in this PR

- His `partly` words read by extraction, so the corrected fact replaces the half-wrong one: a `memory-extract`
  prompt change and version bump, his OK first (AGENTS.md, "Ask first").
- `scripts/eval.ts --ratings` grades true and false only; `partly` is left out like `skip` (through the one
  answer table, above) until the benchmark work (#252) decides how it scores.
- life-loops: `objectives/facts.md`, `loop-facts`, the run-log check and missed runs (its own PR).

## Golden rule plan

Inventory (`rg -n "statements|ratings|recordRating|readRatings|readStatements|ratedFalse|ratedOutdated|addStatements|spread\(|roundRobin|createCheck|check-page|assets/check|/check|createSignIn|PAGES_CLIENT|confidence|importance|unsure"`):
- The draw: `memory/statements.ts:61` `roundRobin`, `:77` `spread`, `:141` `addStatements`; `host/command.ts:190`
  `statements <n>`.
- Claims: `memory/statements.ts:97` `claimsNow` (the one place, AGENTS.md invariant), used by `scripts/eval.ts:21`,
  `scripts/bench.ts:26`.
- Answers: `records/statement.ts:26` `Rating`; `memory/ledger.ts:159` `latestRatings`, `:162` `ratedFalse`, `:174`
  `ratedOutdated`, `:349` `ratedFacts` (the eval's grades), `:366` `recordRating`; `memory/changes.ts:394,458` (`rating.*` events);
  `host/status/snapshot.ts:165` `rated()` (left to rate, unchanged).
- The page: `host/http/check-page.ts` (writer and the known-ref rule `:65`), `assets/check/` (421 lines),
  `host/http/server.ts:89`, `host/http/signin.ts:30` `createSignIn` (only caller `server.ts:89`),
  `host/http/oauth.ts:24,149` `PAGES_CLIENT`.
- Doubt today: `memory/observe.ts:39` `SURE_AT` (read at `search.ts:156`), `records/observation.ts:41` `confidence`, `:48` `importance`, `:29` `INFERRED_USE_AT`, `:235`
  `InferredPerson`; `records/moment.ts:38` `status` `unsure`. Nothing ranks by doubt today.
- Docs: AGENTS.md:37,105,108,116; architecture.md:60,175–179; glossary.md:74; SCHEMA.md:203,320–350; status-reads.md:102;
  brand.md:8,17,39; use/connect.md:45; operations.md:192; tasks.md:154,192.

Shape: what the memory holds stays `claimsNow`; which claims are doubtful is decided once, `doubtsOf`; which reach him
is `doubtful`, replacing the random draw; his answers stay in `ratings.jsonl`, read by the same `ledger.ts`
functions, written by one command instead of a page. No new store, no new connector tool.

State: `Rating.note` and the `partly` answer, per rating, owned by him. `Claim.doubts` and `importance` are derived
on each read, never stored. Nothing global.

Deletes: the check page (route, assets, test), `createSignIn` and its test, `PAGES_CLIENT`, `SESSION`, the 307
argument, `spread`, `roundRobin`, `addStatements`, the `statements <n>` command, `ratedFalse` and `ratedOutdated`
(into one table), their docs.

Net lines: about +150 / −900 (the page and its assets and tests about −700, the sign-in about −150, the draw −45).

Plan review: reshape, then fixed. One fresh top reviewer (29 Oct) found: low confidence must use `SURE_AT`, not
`INFERRED_USE_AT` (that is the inferred-person link rule); `ratedFacts` would have graded `partly` as true, so the
answers' meaning is now one table read by all three; `unsure-moment` could never reach a moment claim, so it is an
observation reason only; the run name `memory.statements` stays (stored); the dead `SESSION`, 307 argument, stale
comments, tests and the architecture line are listed; the "doubtful" rule goes in AGENTS.md. Shape unchanged, so no
second review.
