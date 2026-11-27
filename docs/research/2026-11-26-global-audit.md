# Global audit of Life (26 Nov 2026)

Explanation: an independent, read-only review asked by the owner: is the foundation solid, did we build what the
research said (Nod, OpenBot and the rest), is the structure sound, is the direction right, what to change. Facts carry
their source (file, PR, log, store). **Judgement** is marked as such. Nothing was changed, built, installed or sent.
Counts from his data are counts only, never content.

What was read: `AGENTS.md`, `docs/product.md`, the v4 plan (`docs/plans/2026-11-25-overhaul/`), its code facts, the
v4.1 plan, the Nod and personalization research, the prediction brief, the chat-first plan, issue #1373, the parity
plan, the UI research, the rulebook's opening, git history since 12 Nov, the open issues, the code's sizes and samples
in each layer, today's log (`derived/log/2026-11-26.jsonl`) and the desk's store (read-only).

On the names in the ask: **Nod** is n8n's agent (github.com/n8n-io/nod), so "nod" and "n8n" are one source.
**OpenBot** (nightly-labs) was read from its README and architecture docs only (`overhaul-code-facts.md:104`).
**Grok** appears in the repo only as one of OpenBot's runtimes; there is no Grok research in `docs/`. **OpenClaw**
appears nowhere. If research on those two exists, it is not in the repo, so nothing from it can have been built.

## The short verdict

1. **The memory half is solid.** Layers hold, tests are heavy, docs match the code. Keep it and stop touching it.
2. **The agent half is built but not proven.** Nearly everything the Nod research asked for "now" is in the code. It
   was written in about 25 hours, mostly while the agents were switched off, and it has almost no live mileage.
3. **The app is the weak point, and it is a process problem, not a code problem.** A quarter of the approved design
   is reachable; five of six reviews today failed; unapproved designs were built and merged.
4. **Direction: right.** The bet (one thread, Life does the work, he only answers) is the correct one. The risk is not
   the idea. It is building faster than anyone can check.

## 1. Foundation

### Facts

| Measure | Value | Source |
|---|---|---|
| Server code | 398 files, about 94,000 lines; tests about 74,000 lines | `apps/server/src`, counted |
| Biggest layer | `memory/`: 152 files, 40,750 lines, 142 test files | counted |
| `desk/` | 54 files, 13,100 lines, tests 14,614 lines | counted |
| Files over the 800-line cap | 1 server file in `CAPS` (6 with the voice server), but 12 more server files sit between 800 and 880 lines | `scripts/imports.test.ts:42`, `wc -l` |
| Skipped tests | 6 | grep |
| Lint or type suppressions | 102 in non-test server code | grep |
| Names in `AGENTS.md` that no longer exist in code | 4 of 497 (`PI_COMPACT_AT`, `inboxRankOf`, `notifyKindOf`, `parseX` is a pattern) | script |
| `AGENTS.md` size | 110 KB, 502 lines, longest line 3,444 characters; loaded into every agent session | `wc` |
| `docs/glossary.md` | 149 KB, about 388 rows | `wc` |
| Commits since 12 Nov | 3,914, of which 1,560 merges; +310,000 / −144,000 lines | `git log` |
| PRs merged since 25 Nov | 49; 7 with "Verdict: debt added" | `gh pr list` |
| Open issues | 187; about 60 labelled debt; 5 named "Ultrafast debt" from today | `gh issue list` |
| Agent spend, all time | $2.95 over 706 turns | `desk.sqlite`, `turn.cost_usd` |

### Judgement

**Sound:**
- The layering is real and enforced by tests, not by good will (`imports.test.ts`: no cycles, nothing imports the
  desk, model calls only from listed files). This is rare and worth protecting.
- The memory's design (append-only lines, deletion at read, quotes checked against sources, one lock, cached model
  output) is coherent and matches its docs almost exactly. 4 stale names out of 497 is very good.
- The one-way rules ("one way to do each thing") are followed in the code sampled (`desk/desk-clock.ts` `dueOf` is
  the one due rule; `desk/gate.ts` reads `deliveryOf`; `pi-results.ts` is the one place tool results are wrapped).
- Cost is not a problem. Agents have cost under $3 in total.

**Shaky:**
- **The agent layer has more machinery than use.** The store shows 706 turns in 8 days: 594 ended "waited" (the agent
  woke, looked and went back to sleep), 49 failed, 14 finished. From the decisions file: 145 asks made, 57 answered,
  65 withdrawn, 18 sends. There have been 11 moves between agents. Contests, folds, moves, kept cards and merges are
  each tested, but each exists for a case that has happened a handful of times or never. More asks were withdrawn
  than answered.
- **v4's new parts have run almost never.** The gate has written 3 `delivered` lines. There is no
  `memory/instructions.jsonl` at all: the whole personalization layer (scopes, effects, precedence, `inForceOf`) has
  zero entries. There is no `rated` line. Ask Life has been asked 26 times in total.
- **Today the desk is not healthy.** 28 of 64 turns failed (19 retries, 8 event wakes, 1 ask), one agent looping on
  `RequestError` every 5 minutes (`desk.runtime`, 12:22 to 13:16 UTC). A settings backup named
  `settings.json.bak-2026-11-26-desk-runaway` was made 26 minutes after the desk was switched back on. Three desk
  fixes landed the same day (#1437 the desk would not start, #1440 a stop ask was dropped, #1448 turns cut by a
  restart).
- **Background noise is high and normal.** Today's log has about 400 error lines: the to-do list backend refusing
  (`remctl ... host_signature_invalid`, 49 lines), the pendant server not found by name (`ENOTFOUND` and 502/530, 45
  lines: Life reaches the voice server on the same Mac through its public address), voice-naming queue timeouts (35),
  `gh` not answering (25). Rule 2 of `product.md` says silence must be trustworthy; with this much noise nobody can
  tell a real failure from the usual ones.
- **`AGENTS.md` has become the bottleneck.** 110 KB of rules, with single paragraphs of 3,000 characters holding ten
  decisions each. Every helper loads it; none can reliably follow it. The roadmap already says "AGENTS.md cut to the
  rules that protect data" (`docs/roadmap.md`, item 6). It is the cheapest high-value fix in the repo.
- **12 files sit just above 800 lines without being in `CAPS`.** Either the cap test does not see them or the rule is
  800 code lines, not all lines. Worth one look.
- **Speed target not met yet.** 9 asks measured today: first words in 0.8 to 13.9 s, median about 7 s. The plan's
  target is 3 s for half of asks. It is a clear gain on the 15 to 36 s before v4, and still slow for a chat.

### What I would change first (value over cost)

1. Fix the failing turns and the retry loop before anything else on agents (hours).
2. Cut `AGENTS.md` to the invariants (about 150 lines); move the "one way" table and the dated history to docs (a day).
3. Clear the standing errors, or make each one a fix ask or silent by design (a day).
4. Count what is used in the desk for two weeks, then delete what was not (contest merges, kept, moves' notes phase).

## 2. Wanted against built

Status: **built** (in the code), **unproven** (built, almost no live use), **partly**, **later** (parked on
purpose, with an issue), **no** (dropped on purpose).

### From Nod (`docs/plans/2026-11-25-overhaul/nod.md`)

| Wanted | Status | Where |
|---|---|---|
| A model gives readings, code decides delivery (the gate) | built, unproven: 3 verdicts | `desk/gate.ts`, `prompts/desk-gate.v1.md` |
| Hold at a bad moment, never past the deadline; what he is doing now | built, unproven | `host/owner-state.ts`, `desk/gate.ts` |
| Ask again only on a real change | built | `memory/card-problems.ts` (`changed`) |
| A failed read is never a fix ask; fix asks from a fixed list | built | `memory/fix-checks.ts` |
| A refusal beats a grant (instruction precedence) | built, unused: no instruction recorded | `memory/instructions.ts` |
| Large tool results kept outside the context | built | `desk/runtimes/pi-results.ts` |
| Tool results wrapped as data | built | `pi-results.ts` (`life-data` tag) |
| A dangling tool call closed as "interrupted" | built | `desk/runtimes/pi-session-repair.ts` |
| Compaction from the model's window | built | `pi-extension.ts`; `AGENTS.md` still names the old constant |
| Background work pauses on a failing provider | built; today's retry loop says check it | `desk/runtimes/provider-pause.ts` |
| A turn stops after five failed calls of one tool | built, test owed | `pi-connection.ts:89` |
| The guard reads every tool call | built | `pi-extension.ts`, `desk/send-guard.ts` |
| Queue a second ask; Stop cancels | built | `main-session.ts:230`, `runtimes/contract.ts:86` |
| `finish` refused while his words are unread | built | `desk/agent-questions.ts` (`main_question`) |
| A spend stop per piece of work | built | `turn.stopped_spending`, `desk-clock.ts` |
| Working line rules, reactions both ways | built server-side; the app shows reactions only in its catalog | parity plan |
| Voice and style re-sent on every request | built | `inForceOf`, `turn-ends.ts`, `pi-extension.ts:194` |
| Suggested asks as his own words (`follow`) | built | `memory/card-request.ts` |
| Trust check for what gets past the send guard | later, no issue of its own found | `nod.md` "Later"; `SECURITY.md` |
| Learned procedures (skills) | later | #1380 |
| Browser and desktop control | later | #1381 |
| Backup model, cheaper helper model | later | #1382 |
| Onboarding that ends on one real task | later | #1383 |
| Deferred tools (tool search) | later, waits on numbers | bundle C records them |
| pi's SDK, CodeMode, sandbox, settings pages, Nod's memory | no | `nod.md` "No" |
| Licence: Apache copy and attribution for adapted logic | **missing**. Two files say "after Nod's ..."; the repo has an MIT `LICENSE` and no Apache text or notice | `pi-results.ts:15`, `pi-session-repair.ts:4` |

Nod's "now" list: 21 of 21 are in the code. That is the honest answer to "did we bake it in": yes, on the server.

### From OpenBot (issue #1373)

| Wanted | Status | Where |
|---|---|---|
| A message to a busy agent is queued | built | main session's queue |
| Delegated work needs an explicit reply, 60 s, ownership never moves | built | `askAssignment`, `tell_agent` |
| Stop, resume, reassign | built | `change_registered_agent`, `hand_over` |
| Context watched, compaction before full | built | pi extension |
| Many runtimes | partly: Claude, Codex, pi | `runtime-rows.ts` |
| Free agent-to-agent chat, shared channels | no, on purpose | `positions.md` |
| Embedded browser, computer use | later | #1381 |
| Self-hosted server mode | not built | `docs/plans/2026-10-22-server.md` |

### From the personalization research

| Wanted | Status |
|---|---|
| One contract for what he wants, scoped, dated, replaceable | built (`instructions.jsonl`), unused |
| One reader used by session, agents, order, push | built (`instructionsFor`) |
| Rules enforced by the code that notifies | built for `quiet`, `interrupt`, `batch`, `sensitive`, `budget`, `hands-off` |
| A changed rule applies without a restart | built for instructions (read fresh); settings still read once per process |
| Decisions record what he was shown, the recommended option, the rules applied | built (`delivered` lines, `recommended`) |
| Importance, urgency, good moment, can act kept apart | built (the gate's four readings) |
| Standing intentions as work | built (`openIntentions`), unused |
| The learner (replay, benchmark, rollback) | later: the prediction plan, not started |
| Inferred tendencies (a model-owned preference layer) | missing, and no plan line for it |

### From the pi audit and the v4 plan itself

| Wanted | Status |
|---|---|
| Answers as Markdown with checked blocks | built; 7 dropped blocks today (`block.miss`) |
| The thread kept on the Mac | built (`thread_entry`) |
| Undo, on sends where the chat allows | built in code; each network still needs its one real try |
| Plan cards removed | built |
| "How am I doing?" | built; the once-a-day rule sits on the phone, not the server (#1424) |
| First words within 3 s for half of asks | missed: median about 7 s today |
| Cost and success measures reported | recorded; no report he or anyone reads |
| The app matches the prototype | **13 of 52 states** reachable; 15 only in a debug catalog; 24 not at all |
| Seven ask kinds the server sends | **no approved design**; drawn today from unapproved lab picks |
| Renames (`truth/` to `stated/`, the desk) | later (#1379, #655) |
| True deletion (purge) | later (#1384) |

## 3. Structure

**Right shape, keep:**
- **Matters.** They are what he sees, what an ask hangs on, what "done" and deletion reach. Every system that lets
  agents organise themselves ends up with a task table with one owner each; this is that table. 62 exist. Keep.
- **Cards (decisions) with the exact draft.** The one gate that makes full-power agents safe. Keep without exception.
- **The connector.** One door, typed, his token against an agent's. Good.
- **Listening, arrivals.** The arrival reader (cheap sieve, then a confirm) is the right design and the most
  valuable live feature: it is what makes Life act within minutes.
- **The main session.** One conversation that can do everything on his word. Right.

**Overlaps and things to merge:**
- **Checks, decisions, cards, asks, thread items, fix asks, your-move cards.** Seven names for "something he
  answers". The code has one list (`checksNow`), which is right, but the words multiply in docs, wire and app. Pick
  one user word ("ask") and one code word, and retire the rest from the wire.
- **Personal agent, project agents, caretaker.** In practice one worker does almost everything (the v4 plan already
  says a project agent exists only with a repo). The caretaker is stopped and fix asks are now written by code. I
  would fold the caretaker's job into the Personal agent with a role flag on the assignment, not a third standing
  agent. Fewer standing agents, fewer rules about who holds what.
- **Hand-out, fold, move, contest, keep, merge.** Six mechanisms for "which agent has this and whose draft goes".
  With one worker plus repo agents, contest and fold nearly vanish. Measure, then delete.
- **Settings, instructions, corrections, labels, `truth/`.** Five places his wishes live. The split is defensible
  inside, and v4 hides it from him, but a new builder cannot hold it. The rename to `stated/` helps; do it.
- **Projects.** The plan's own verdict ("context, never agents") is right. Then stop routing by project at all except
  "has a repo".

**Missing:**
- **A place where he sees what Life did.** Rule 4 of `product.md` says hidden is never unreachable. With 594 silent
  turns, "what did you do today?" must have a good answer. I found no measured check of that answer.
- **Inferred preferences.** Explicit instructions exist; the model-owned half (what Life learned from his choices)
  does not, and nothing reads the 57 answers yet.
- **A health view for builders.** One page: turns failed, asks asked, answered, withdrawn, held, time to first
  words, errors by kind. Everything is recorded; nothing adds it up.
- **A second user.** The roadmap's goal is "a product for people other than its author", and nothing in the last two
  weeks moved toward it. That is fine, but say so.

## 4. Direction

**Judgement: the direction is right.** A memory that runs itself, agents that act on it, and one thread where he only
answers is the correct product, and no open system read here (Nod, OpenBot) has the memory to do it. Nod's own design
confirms Life's choices more than it challenges them: code decides, models only read.

**Bet on:**
- The arrival path: message in, ask with a ready draft within minutes, one tap. It is the product. Make it boringly
  reliable before anything else.
- The gate and "what he is doing now". Fewer, better-timed asks is the whole promise.
- The memory as it is. No more layers until the agents use the ones that exist.

**Stop, or pause:**
- New agent mechanics. No new effect, role, wake or card field until the existing ones have a month of live use.
- Design exploration in parallel with building (the lab, aura tuning, card variants). One approved prototype, then
  the app matches it, then the next design.
- Ultrafast mode on anything he sees. It produced the speed, and it produced today.
- New sources and add-ons. Nineteen sources are on; the value now is in acting, not in reading more.
- Prediction (the fourth layer). The records are being kept; the learner can wait until there are a few hundred real
  answers. Today there are 57.

**The open worry in #1373 ("is Life too opinionated?")**: half right. Matters are needed. The opinions to drop are
about agents (who holds what), not about matters.

## 5. Gaps and risks

1. **Speed of change beats speed of checking.** The whole of v4 (five server bundles, three phone bundles) merged
   between 22:53 on 25 Nov and 00:16 on 26 Nov; v4.1 by 11:19. Nobody, human or model, can know what that code does
   live. Most of today's fixes are for things a single live run would have shown.
2. **He is the test.** Parity plan: 5 of 6 design reviews failed; three merged fixes broke when he opened the app.
   The live-run rule (#1449) is one line in `AGENTS.md`; nothing enforces it.
3. **Unapproved design shipped.** #1430 and #1435 built "lab picks" into the app (about 3,200 lines) hours before he
   ruled that only the original prototype is approved. That code is on main. Seven ask kinds have no approved design.
4. **Raw insides reached him.** The Messenger sign-in showed the bridge's own words about cookies and cURL (#1465).
   The plan said he never sees a cookie; the build passed anyway because no check reads the screen as he does.
5. **Tooling fragility.** A dead build lock cost 27 minutes (#1463), caused by a change made 50 minutes earlier
   (#1457); a second race is still open (#1464). All 15 phone flow tests are broken on main by one stale label, and
   they are not part of the check.
6. **Debt is being filed faster than paid.** 187 open issues; each ultrafast PR opens a debt issue; `tests-owed.md`
   lists what was not tested. The rule "every change leaves less debt" is not what the last two days did (7 PRs
   merged as "debt added").
7. **The send guard is partial, by its own words** (`desk/send-guard.ts` header, `SECURITY.md`): `curl`, `gh api`, a
   browser tab get past it. Acceptable for one owner on his Mac. A blocker for any second user. No plan exists yet.
8. **Deletion is at read only.** His deleted words stay in the voice store, the archive, backups and git history
   (#1384). Stated honestly in `SECURITY.md`; still a promise the product makes in its name.
9. **Too many sessions steering.** Direction, Designer, builders, fixers, helpers, each with rules about who may
   message whom (about 15 memory notes on this alone). The lab-pick incident is what that costs.
10. **Licence hygiene.** Logic adapted from Nod without the Apache text or a notice. Small, and free to fix now.

## 6. Recommendations, in order

| # | Do | Fixes | Cost | What he sees |
|---|---|---|---|---|
| 1 | **Stop new features for one week.** Only fixes, on main, from one builder | Change outrunning checks | 0 | Nothing breaks when he opens the app |
| 2 | **Make the desk healthy and keep it on.** Fix the failing-turn loop; one daily number: turns failed, asks sent, answered, withdrawn, held | Unproven agent layer | 1 to 2 days | Asks that arrive, with drafts, and fewer pointless ones |
| 3 | **Build the parity harness** (the parity plan's option D), fix the 15 flow tests first, and make it required on every phone PR | He is the test | 2 days, then 10 min a run | A board: "x of 52 screens match"; he stops hunting |
| 4 | **Decide the lab-pick code**: he approves each of the 7 ask kinds from the Designer's page, or it comes out | Unapproved UI on main | 1 hour of his time, 1 day of work | Only looks he chose |
| 5 | **A screen-reading check before "done"**: a fresh reader with no context reads each new screen's words and flags anything technical (cookie, JSON, agent, model) | Insides shown to him | Half a day | No more builder's words |
| 6 | **Cut `AGENTS.md` to about 150 lines of invariants.** History and the lookup table move to docs | Rules nobody can follow | 1 day | Helpers stop breaking rules he already set |
| 7 | **End ultrafast for what he sees and for the desk.** Keep it for throwaway tools. Pay the 5 ultrafast debt issues before new phone work | Debt outpacing | 2 to 3 days | Slower merges, fewer regressions |
| 8 | **Quiet the log.** Each standing error becomes a fix ask, a real fix, or silence by design; the voice server reached locally | Silence that cannot be trusted | 1 day | "Something is broken" means it |
| 9 | **Simplify the agents after two weeks of counts.** One worker plus repo agents; caretaker folded in; delete unused contest and move paths | Machinery over use | 2 to 3 days, mostly deletion | Nothing; fewer strange behaviours |
| 10 | **Write the security plan before any second user**, and add the Apache notice now | Partial send guard; licence | Plan: 1 day; notice: 10 minutes | Nothing now; a product others can use later |

After that week: speed (first words under 3 s), then "what did Life do today?", then onboarding, then prediction.

## What I could not check

- The app on a phone or simulator (read-only brief; I relied on the parity plan's measured counts).
- Nod's and OpenBot's own code (the plan's reading passes were taken as given).
- Whether each Undo works on its real network.
- The quality of the memory's content (facts right or wrong); the eval was not run.
