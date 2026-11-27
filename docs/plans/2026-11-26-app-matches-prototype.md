# The app matches the prototype: the plan

Explanation: how to bring the iPhone app to the approved prototype (app v4, `docs/design/chat-first/prototypes/shell.html`,
read with its rulebook `2026-11-26-original-components.md`) and keep it there, without the owner acting as QA. Research
and plan only, 26 Nov 2026. The lab picks (`2026-11-26-lab-decisions.md`) are not approved and are not a target.

## The gap today, measured

The prototype is driven by its side panel: **52 scenario buttons** in 15 groups (opening 3, long work 4, redraft 2,
reactions 3, rating 1, Undo 2, settings 4, held asks 3, aura 6, Ask Life 11, field state 3, where you are 2, failures 5,
outside Life 2, waiting 1), on top of **34 asks of 15 kinds** in its data and **7 profiles**.

The app has **24 E2E scenarios** (`LifelogE2E/scenarios/`), **15 flow tests** (all 15 broken on main by one stale button
label), and a Debug catalog of about **20 component sections** (`DesignSystem/Catalog.swift`) drawn from fixed values,
not from the wire.

Mapped one by one, the prototype's 52 states fall into three groups:

| The app can reach the state | States | Which |
|---|---|---|
| From data, through an E2E scenario | about 13 (25%) | opening clean and broken (OP1), draft (C1), rating (C20), Undo WhatsApp and iMessage (C11, C10), a person as the answer (C12), offline and Mac out of reach (O2, L5), sign back in (N1), outdated (C16), waiting list (W1), one slow answer (M1) |
| Only as a component in the catalog | about 15 | reactions, settings block, held separator, aura knobs, answer blocks, quick edits, notices |
| Not at all | about 24 | long work handed off and its spending stop, redraft by words, "What can I change?" and its offline form, meeting and morning holds, the aura asked in words, most Ask Life answers (offer, option, yes before an act, which one, value, your words), listening and working field states, away from the Mac, pendant stopped, budget at 90%, a notification |

What was compared so far, all today: about **34 prototype states** and **45 app screens** shot across 18
`screens-*` folders, in 6 reviews. **5 of the 6 failed** (prototype audit: 31 mismatches of 64 elements; assembly: 10
must-fix, 10 should-fix; final review: 6 must-fix; nav, layout, integrate-2: fail). The catalog review alone passed:
the components hold in isolation, the screens built from them don't.

Two more gaps sit outside any screen diff (`docs/research/2026-11-26-ask-coverage.md`): no ask appears in the thread
unless an answer cites it, and every ask kind draws as title, question and options, so the payment and call cards the
prototype draws are missing. Seven ask kinds the server sends (voice naming, new matter, ending, same person, Contacts
card, at organization, your move) have **no design at all**: no builder can match what isn't drawn.

So the gap is not a list of small misses the owner happens to find. Three quarters of the prototype's states have never
been put next to the app, and nothing re-checks the quarter that has.

## Four strategies

| | A. He reviews one by one (today) | B. One full audit, fixed in batches | C. Shared tokens and components first | D. A parity harness, then batches (recommended) |
|---|---|---|---|---|
| What it is | He opens the app, sends a screenshot, one PR per gap | A fresh reviewer pairs all 52 states once, scores them, fixes grouped by component | Glyphs, type, spacing, row and card shells made identical first, screens after | Each prototype state gets an app scenario with the prototype's own made-up data; a script shoots both and pairs them; batches fixed by component; reruns on every UI PR |
| What he does | All the finding, every day, without end | Reads one report, then checks the result | Nothing until screens change | One yes now; 5 minutes in the evening on changed rows only; one live check at the week's end |
| Cost | His time; one build and swap per gap; one gap per PR | About a day of agent time; builds per batch | 1 to 2 days, few visible results | 2 days to build the scenarios and the pairing script; then about 10 minutes and one build per full run |
| Finds | What he happens to open | All 52 states, once | Component drift only, not flows or states | All 52 states, every run |
| Stops gaps returning | No | No: a snapshot, stale after the next PR | Partly: components can't drift, screens can | Yes: a changed pair shows on the next run, for the app and the prototype both |

A is what the owner said he wants to leave: he is the only test, and today's six reviews show each fix leaving the
next gap for him to find. B is what today already did five times; each review was right and went stale within hours.
C is real work but invisible to him, and the catalog already passes. D keeps B's reviewer and does C's work as fixes
grouped by component, and adds the one thing missing: the pairs exist as data, so they rerun.

## The recommendation: D, with a "works" column

The research of the same day (`docs/research/2026-11-26-ai-ui-without-slop.md`, "For Life") confirms D and adds what it
lacked: looking right and working right diverge, an agent's own account of its UI work is not evidence, and the owner's
judgment is worth most on taste and load, least on hunting. The board below folds its seven additions in.

### The board

One row per state; a row is green only when every column is.

| Column | What fills it | Who decides |
|---|---|---|
| Looks | App shot beside prototype shot, same made-up data, 390 × 844; the text and box diff (`scripts/design-compare.ts` fed the prototype's DOM boxes); the reviewer's score | The script's diff, then the reviewer |
| Works | The state's task (goal, taps, expected result) run by `agent-device` on the fake Life; the fake Life records what the app sent (the answer, the send, the undo, the setting) and code compares it with the expected call | Code only |
| Taps | Taps to finish the task in the app, beside the clicks the same task takes in the prototype | A number: more taps than the prototype is red |
| Accessibility | Apple's `performAccessibilityAudit` in the XCUITest journey that reaches the state, at the default and the largest text size | The audit, blocking only on clipped text and on an issue the prototype's state lacks; contrast and Dynamic Type are shown, never blocking (the owner's rule of 27 Nov 2026, below) |
| Owner | His flag, if he gave one | Him, on taste and load only |

The owner's rule for the Accessibility column (27 Nov 2026), his words: "accessibility, like contrast and text size, we
don't care about much if it's already what the design has provided for… we just want to follow the design. Cut-off
text, yes it's an issue. I just want things to be fast." (`blockingA11yOf`, `scripts/parity.ts`.)

The rows:

- **52 happy states**, one per prototype scenario button. About 30 are tasks (something he does: answer, send, undo,
  change a setting, ask Life); the other 22 are states he only sees (a notice, a held separator, the aura), so their
  Works and Taps cells are empty.
- **18 unhappy states**: empty, slow, offline, failed send, a long name, the largest text size, each for the item row,
  the unfolded ask and the thread. The prototype draws about 8 of them (the empty list, offline, not sent, the slow
  answer, the working field); the other 10 are **"no design"** rows, sent to the Designer session in one list with the
  7 undesigned ask kinds. A builder never guesses one.
- **Total about 70 rows.** A gap the owner finds later is a missing row: the row first, then the fix.

### Who checks what

- **The builder** fixes by component and leaves its harness behind (the scenario, the task, the expected call). Its
  "matches" counts for nothing: the row turns green only when the script and the audit say so (the research's "Design
  Theater": a quarter to a third of the work agents describe is absent).
- **The reviewer** is a fresh agent that sees only the pair and the task's recording, never the code or the builder's
  notes. It compares two images rather than scoring one. Before it judges anything, it is calibrated on today's six
  reviews and the owner's past calls: it must find their must-fix items from the shots alone, with a set threshold
  (a pair scoring under 8 of 10 is "differs").
- **Pixel snapshot tests** cover only the stable components: the item row and the ask card in their states. Everything
  else is carried by the pairs; snapshotting it all would break on every honest change.
- **A persona run** (`agent-device` with the Callstack `dogfood` skill, over the fake Life) once a week, for
  exploration: each finding comes with a repro video and becomes a row if real. It never decides "done".
- **The owner** sees only the rows that changed since he last looked, the pair and the tap counts side by side, and
  judges taste and load. A flag becomes a row before any fix.

**Done**, for a UI change: every row it touches green in all columns, then one live run on his real Life ("Done means
ran live"). The live screenshot confirms; it no longer searches.

### The pieces, and what is new

Already there: the fake Life in the app (`Lifelog/E2E/E2ELife.swift`, scenarios with steps and a fixed clock, and
`calls.jsonl`, where the app already logs every call it makes, which is what the Works column reads); the prototype in
headless Chromium, each state one side-panel click; `argent` and `agent-device` for the simulator; `design-compare.ts`;
the fresh-eyes prompt; the heavy lane for builds.

New: one script, `bun run parity [ids]`, which writes `docs/design/chat-first/parity/<row>.png` and
`parity/board.json`; about 50 new scenario files with the prototype's made-up data (Ben, Jade, the clinic, the beads);
an `expect` part in a scenario (the calls a task must produce); the audit call in the XCUITest journeys; two snapshot
tests; the board as a private artifact he opens on his phone, showing changed rows first.

Limits, said once: the diff sees words and boxes, not colour or motion. Colour and type come from `tokens.css` on both
sides, so the shot covers them; motion (the edge, ink-in, folding) gets a recording for the few rows where it is the point.

## Cost

Builds are one at a time on his Mac, through the heavy lane.

| Run | Builds | Time on the Mac | Model tokens |
|---|---|---|---|
| Full board (70 rows) | 1 | about 40 minutes: 70 launches with their tasks, two text sizes for the journeys | about 300k for the reviewer if every row is reviewed; only changed rows are, so usually under 50k |
| One UI PR (its rows, usually 3 to 8) | 1 | 3 to 8 minutes | 10k to 30k |
| Weekly persona run | 0 (the last build) | about 30 minutes | about 500k |
| The first week, all in | about 15 to 20 (one per batch, never back to back) | about 6 hours of simulator time, spread over the week | about 8 to 12M: two or three Sonnet helpers building scenarios and fixes, Opus only for the reviewer's calibration |

The first week costs more than the one-by-one way would in a week. From the second week, each UI PR adds about 5
minutes of simulator time and almost no model tokens, against today's one build and one owner check per gap.

## The first week

| Day | Work (agents) | What the owner sees |
|---|---|---|
| 1 | Fix the stale label so the 15 flows pass. Write `bun run parity` and the Works check over the 13 states the app reaches today; first full run; the board published. | The board link: 13 rows filled, the rest "not built" or "no design". Nothing to do. |
| 2 | Calibrate the reviewer on today's six reviews. Add the accessibility audit to the journeys. Scenarios and tasks for about 20 more happy states (Ask Life answers, settings, held asks, failures). Send the "no design" list (10 unhappy states, 7 ask kinds) to the Designer session. | Nothing. |
| 3 | Scenarios for the 18 unhappy rows that have a design. Group every red row by component. First fix batch: the item row and the unfolded ask (they are on every screen), with their two snapshot tests. | Evening, 5 minutes: only the changed rows, pairs and tap counts. He flags taste, nothing else. |
| 4 | Fix batches: the field, the notice, the profile, the answer blocks. Rows he flagged first. | Evening, 5 minutes, changed rows only. |
| 5 | Scenarios for long work, the aura and the listening and working field (recorded). Fix batch. First persona run. | Evening, 5 minutes, plus the persona findings that became rows. |
| 6 | One live run on his real Life of the screens that changed, each app shot beside its row. | He opens the app once, on screens already green. Anything wrong becomes a row. |
| 7 | Leftovers on the board; the rule "a UI PR reruns its rows and is done only when they are green" written in the iOS app's `AGENTS.md`. | The week's result: green rows before and after (today about 0 of 70 fully green), and what waits on a design. |

From week 2 the owner's part is the 5 minutes on changed rows and one weekly glance at the persona run.

## What the owner decides

- Yes or no to this plan, and to its first week's cost (above).
- Whether the board's 5 minutes come at a fixed time (evening) or when a batch lands.
- Whether "more taps than the prototype" is always a fail, or only a warning he sees.

Not decided here: whether the parity run joins `bun run check` (it needs the simulator; a pre-push for UI changes is
the likelier place).
