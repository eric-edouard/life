# Told Life: one way for his words to reach memory, and no more pages

**What it is:** what the owner tells Life on purpose ("hey Life, remember…", a message to himself, a chat with
ChatGPT or Claude) is a **mark**: those lines are read at importance 3 and extraction writes every fact in them. It is
not a new pipeline, store or page: marked units go through episodes → extraction → pages like any other.
**What goes:** the decisions page and the whole web app it is the only page of. Fact checks move into chats.

Decisions he gave (8 Nov): built into Life, no setting; three ways in (voice, self-messages, chat tool); remove the
decisions page; fold fact checks into the chat interview. Open for him: **D1**, **D2**, **D3** below.

## M1. A mark is a property of a source line, from any source

- [ ] `SourceEvent.marked: true` (`records/source.ts`): this message is his words to Life. Readers set it; nothing
      else decides it.
- [ ] `chatDay` (`memory/units.ts`) gives the unit `marked` = the ids of its marked events, as lifelog's units already
      carry turn refs. `importanceOf` (3), extraction's `(marked)` lines and the nightly's list then work unchanged.
- [ ] `MARKED` text says what it now means ("He told Life to remember what follows"); the 20 stored marked voice units
      move hash and are read again (cheap, his 22–28 Oct "hey Life" asks).
- [ ] `Unit.marked` comment, glossary `mark`: any source, not only lifelog.
- [ ] Nightly section "Asks remembered" → "Told Life" (`report.ts`, `markedSince` unchanged).

## M2. Three ways in

- [ ] **Voice:** "hey Life" is Life's own wake (`hear.ts`): it marks its span and makes no ask. Settings refuse
      "life" as an agent's wake or misheard word (the existing refine in `core/settings.ts`). Tests: "hey Life,
      remember…" marks, makes no ask; "hey lifelong friend" still nothing.
- [ ] **Message to himself:** a message from him to only him is marked.
      - Mail (`sources/mail.ts`): his sent message whose every recipient is one of his addresses (`mailAccounts`).
        Reads Apple Mail's `recipients` table for his sent messages only.
      - Chats: decided once, in `chatDay`, by the rule that already says whose a 1:1 chat is (`chatPerson`,
        `closeness.ts:61`, exported): a chat it maps to `OWNER` is a self-chat, its messages marked. No chat reader
        changes. Checked on his data per source (iMessage, WhatsApp, a bridged network) before merge.
      - New self-messages only: past ones keep their units (no backfill, no quota).
- [ ] **Chats (connector):** tool `tell_life({ said, asked? })`, his words verbatim and, in an interview, the
      question he answered. Appends one line to `memory/told.jsonl` (append-only, one synchronous line like a
      correction, outside the lock). Read back by a new source `told` (in `SourceName`, kind `own_writing`,
      `sources.ts`), on through his `sources` setting like every source; while off, `tell_life` is not offered (as
      `payments()`). One unit per
      local day, his lines `marked`, a question shown as the app's line, never his. Refused when the caller is an
      agent (its grant's agent claim): an agent's words are not his. Not destructive (a `wrong` correction undoes it).
- [ ] Connector instructions: when he asks to remember something, `tell_life` with his words (stays ≤ 512 chars).

## M3. Fact checks in the chat, the decisions page gone

- [ ] One helper for "drawn, not rated, not expired" (`ledger.ts`): a statement expires 7 days after its `at`
      (derived, nothing stored; an expired one counts as skipped as today). Used by `snapshot.ts:160`, the night's
      top-up and `read_fact_checks`; replaces `fact-checks.ts:99`.
- [ ] `read_fact_checks`: those statements with their quote and their doubts (`doubtsOf`, worked out again: not
      stored). A pure read.
- [ ] `correct_memory` gains kind `fact_check` `{ref, answer: true|partly|false, note?}` → `recordRating`.
- [ ] The night keeps up to 5 unrated statements drawn (`drawDoubtful(room)`, under its lock); the midday run keeps
      its sweep, loses fact checks. `askFactChecks`, `factCheckAsk`, `recordFactCheck` go.
- [ ] Delete: `apps/web/` (1,282 lines), `host/http/web.ts` + test, its route in `server.ts`, `WEB_DIST`, the web
      build in `scripts/helper.ts` and `scripts/check.ts`, `scripts/web-layout.ts`, `biome.json`'s web block,
      `brand.test.ts`'s web parts, `memory/decisions.ts`, `records/decision.ts`, `DECISIONS` in `ledger.ts`,
      `/me/decisions` redirect + test, the web deps (react, tanstack, vite, tailwind, motion, base-ui), `package.json`'s
      `check:web`, `.fallowrc.json`'s web entries.
- [ ] `memory/decisions.jsonl` stays on disk, read by nothing (memory is never wiped). `host/migrate.ts` keeps its
      file list as it is unless its migration is already done and gone.
- [ ] **D1 (his call):** the legacy portrait `/me` signs in through the web app's page. Recommended: delete it with
      `sign-in.ts` and `LIFE_PORTRAIT_PASSWORD` (roadmap: "deleted when it stops being fun"). Then Life serves no page
      at all: only `/mcp` and its OAuth.
- [ ] **D3 (his call):** the roadmap's "Next" (`roadmap.md:40`) keeps `apps/web` for the parked server version's
      pages. Recommended: delete it now (no pages is the product); the server version rebuilds what it needs.
      Keeping it means removing only the decisions page and `/api/decisions`, and the web app stands empty.
- [ ] **D2 (his call):** the three new connector changes (`tell_life`, `read_fact_checks`, `fact_check`) cost one
      ChatGPT reconnect; batch any other connector change he has in mind.

## M4. Docs and rules

- [ ] AGENTS.md: connector invariant (reads, corrections and fact-check answers, `change_todo_item`, `tell_life`
      which only appends his words); "his input arrives in conversation only" loses the `/decisions` exception; the
      lock list swaps `decisions.jsonl` for `told.jsonl`; pages invariant per D1.
- [ ] `docs/tasks.md` Marks, `docs/sources.md` (told, self-messages), `docs/SCHEMA.md` (told.jsonl, decisions.jsonl
      historical), `docs/glossary.md` (mark, told, `tell_life`; drop decision, overview, web app per D1),
      `docs/architecture.md` (192, 210-219), `docs/brand.md` (18, 24, 33), `docs/operations.md:89`, `SCHEMA.md:228`
      ("what the owner told Life" becomes "his corrections"), `hear.test.ts:53` and `tasks.md:136` (hey Life is
      Life's own), `SECURITY.md` (connector writes: `tell_life`; a chat client could be steered by
      a page into calling it: the tool takes only his verbatim words and agents are refused; the risk is a wrong
      fact, undone by a correction), `docs/roadmap.md` (Next, per D3).
- [ ] `bun run check`; a regression test per way in (made-up people and handles).

## Golden rule plan
Inventory: `rg -n "marked|MARKED|writeMarks"` → `records/unit.ts:106`, `memory/units.ts:212,263-282`,
`memory/words.ts:169`, `memory/episodes.ts:213`, `memory/extract.ts:478-484`, `host/nightly.ts:323-369`,
`host/report.ts:59,194`, `host/hear.ts:17,213`. `rg -n "decisions|fact-checks|FACT_CHECKS|apps/web|WEB_DIST"` →
`memory/decisions.ts`, `records/decision.ts`, `memory/fact-checks.ts`, `host/http/web.ts:5-62`, `server.ts:14`,
`portrait.ts:69`, `ledger.ts:72`, `migrate.ts:40`, `nightly.ts:240-247,453`, `core/paths.ts:9`, `scripts/helper.ts:28`,
`scripts/check.ts:68-79`, `scripts/web-layout.ts`, `scripts/brand.test.ts:96-139`, `biome.json:17-27`. Wakes:
`hear.ts:29-75`, `core/settings.ts:23-45`. Self-messages: nothing today (`SourceEvent` has no recipients;
`speakerOf` `units.ts:364`). Owner handles: `read-truth.ts:95` `handlesOf`, `me` in people.yaml. Ratings:
`ledger.ts:511` `recordRating`, `statements.ts:86,161` `doubtful`/`drawDoubtful`. Connector: `mcp.ts:118-134,391`.
Shape: one place turns "his words to Life" into `Unit.marked`: `chatDay` (self-chats by `chatPerson`, mail and told
by `SourceEvent.marked`, which only those readers can know), lifelog's turns already in `units.ts:263`. Everything downstream already reads
`Unit.marked`. Fact checks keep their one source (`statements.jsonl` + `ratings.jsonl`); only their front end moves.
State: `memory/told.jsonl` (his lines, append-only, per entry). `SourceEvent.marked` per message, derived from the
source each read. No global state.
Deletes: the web app, its route, build and check steps, the decisions fold and record, the fact-check decision
plumbing, the web deps; per D1 the portrait and sign-in. Old name "Asks remembered".
Net lines: about +300 / −2,300 (−2,450 with D1; about −700 if D3 keeps the web app).
Plan review: reshape, fixed: self-chats by `chatPerson` in one place, not per reader; one unrated helper with a
derived 7-day expiry (no starvation); `told` on through `sources`, tool gated; delete and docs lists completed;
D3 added for the roadmap's web app. Shape unchanged, no second review.
