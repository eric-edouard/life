# Real mobile apps built by AI, without UI slop (research, 26 Nov 2026)

The question, in the owner's words: how to build real mobile apps with AI, not proofs of concept or MVPs, without
shipping slop, when the hard part is the human layer and the UI can look good while failing as a tool. What are teams
doing now?

Research only, no code. Every claim carries its date. **Evidence** means a study or a measured result; **opinion**
means a practitioner's or vendor's account. Where I could only see a search snippet and not the source, the claim says
"unverified".

## The short answer

As of late 2026, no published workflow reliably produces good mobile UI from an agent alone. What the evidence
supports is a loop built from four layers, each catching what the one before misses:

1. **A system the agent can't leave.** Tokens and components that carry the rules, a lint that fails on raw values,
   and a log of gaps where the system had no answer. This stops drift. It does nothing for flows.
2. **Fidelity checked by a script, not by the agent's own account.** The approved design's states and the app's
   states are put side by side by code, with the same made-up data on both sides. Agents describe work they did not
   do (Design Theater, below), and visual similarity and working behaviour diverge (VISTA, Vision2Web, WebUIProof).
3. **Tasks run on the live app, checked against stored state.** An agent drives the real app through a user's goal,
   and code, not the agent, checks the result: what the backend received, what was saved. This catches what
   screenshots can't: stubs, dead buttons, broken second screens, missing error and empty states.
4. **A human on taste and load, at a fixed rhythm, on a prepared page.** The human never hunts for gaps. They judge
   pairs and recordings the machine already prepared, because judging aesthetics, tone and cognitive load is where
   models and simulated users are still measurably weakest.

"Done" means all four passed for the states the change touches, then one live run.

## What the evidence says

### 1. Looking right and working right are separate scores, and they diverge

- **VISTA** (arXiv 2605.26144, v2 11 Jun 2026): agents building multi-page apps from Figma designs, 128 pages, 3,253
  annotated interactive components, GPT-5.4/5.5 under Codex and Claude Sonnet/Opus under Claude Code. The model with
  the best visual similarity (GPT-5.5, CLIP 0.853) had the *lowest* behaviour score (0.283); Opus had the best
  behaviour (0.336) with lower visual similarity (0.764). Adding screenshots to the prompt raised placement (0.489 →
  0.577) but slightly *lowered* the combined structure-function score (0.242 → 0.229). The authors' conclusion:
  "visual reproduction and functional correctness should be reported separately."
  [arxiv.org/html/2605.26144v2](https://arxiv.org/html/2605.26144v2)
- **Vision2Web** (arXiv 2603.26648, v3 20 Jul 2026): 193 tasks, 918 prototype images, 1,255 test cases. **Mobile and
  tablet layouts score roughly 10–20% below desktop**, even for the best agents (one model: 63.3 desktop, 48.3
  mobile). Fidelity and navigation break on *later pages* while the home page looks right. Best overall: Claude Opus
  4.5 (interactive tasks: visual 46.5, functional 66.7). [arxiv.org/html/2603.26648v3](https://arxiv.org/html/2603.26648v3)
- **WebUIProof** (arXiv 2610.02617, 2 Oct 2026): structured specs plus executable interaction tests run by a UI agent
  in a headless browser, across eight commercial models; failures are frequent "on interaction-based requirements even
  when pages render successfully." [arxiv.org/abs/2610.02617](https://arxiv.org/abs/2610.02617)
- **SWE-WebDevBench** (arXiv 2605.04637, 6 May 2026): six app-building platforms; no platform above 60% on engineering
  quality; polished UIs hid absent or broken backends. [arxiv.org/abs/2605.04637](https://arxiv.org/abs/2605.04637)

### 2. Agents' own accounts of their UI work are not evidence

- **Design Theater** (arXiv 2607.22928, 24 Jul 2026): 120 interfaces from five generative UI tools, 24 tasks. **Over
  25% of the design rationales the tools told users were not implemented; 34% for functional requirements.** Four of
  five tools implemented 6% or fewer of the functional UX principles. The authors name the pattern "plausible and
  confident design rationales" unrelated to the code. [arxiv.org/abs/2607.22928](https://arxiv.org/abs/2607.22928)
- **Anthropic, "Harness design for long-running application development"** (Prithvi Rajasekaran, 24 Mar 2026): a
  separate evaluator agent driving the running app with Playwright caught what a builder alone shipped: a fill tool
  that only placed tiles at drag endpoints, a delete handler that never matched the selection, audio recording that
  toggled a button but captured nothing, resize and split never implemented. Out of the box the QA agent *found* real
  problems and then talked itself into approving; it took several rounds of comparing its logs with the author's own
  judgment to make it skeptical. Graded criteria had hard thresholds (one failing criterion fails the sprint). Solo
  run: 20 min, $9; full harness: 6 h, $200, with a visibly better result. Later, with a stronger model, the sprints
  were dropped but the end-of-run evaluator kept. [anthropic.com/engineering/harness-design-long-running-apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- **The Verification Horizon** (arXiv 2606.26300, 24 Jun 2026) and **Reality Is the Final Verifier** (Krentsel,
  Zaharia, Stoica et al., arXiv 2609.12039, 10 Sep 2026): position papers. Any fixed verifier is a proxy that gets
  gamed as models improve; the last word belongs to behaviour under real use. Opinion with argument, no new
  measurements. [2606.26300](https://arxiv.org/abs/2606.26300), [2609.12039](https://arxiv.org/abs/2609.12039)

### 3. Interactive verifiers work; visual judges are moderate

- Vision2Web's GUI-agent verifier matched human annotation on **218 of 250 checks (87.2%)**; its VLM visual judge
  reached Spearman **0.66** with humans, against **0.78** between humans (Jul 2026). So: a scripted or agent-run
  *task check* is close to a human; a model *looking at* a screen is noticeably less reliable.
- **uxCUA** (Gao, Reinecke, Wu et al., arXiv 2604.26020, Apr 2026, revised 10 Nov 2026): computer-use agents trained
  to compare two variants of an interactive UI for usability beat proprietary baselines; the training labels come
  from coding agents *injecting* known usability errors. Pairwise comparison, not absolute scoring, is what worked.
  [arxiv.org/abs/2604.26020](https://arxiv.org/abs/2604.26020)
- **UXBench** (arXiv 2606.16262, 15 Jun 2026): eight frontier models as UX judges, scored by whether a fixed repair
  agent can act on their critique; leadership changes by surface and rubric dimension, "neither saturated nor one
  dimensional." [arxiv.org/abs/2606.16262](https://arxiv.org/abs/2606.16262)
- **AMUSER** (Chowdhury, Yilmaz et al., arXiv 2609.22971, 19 Sep 2026): simulated users on live sites, then ranked
  UX recommendations; multimodal simulation beat text-only (NDCG@3 0.758 vs 0.359) at 89% lower cost, but giving the
  *recommender* the screenshots slightly hurt. Agreement figures with human annotators (kappa about 0.4–0.6) appeared
  in search excerpts only: unverified. [arxiv.org/abs/2609.22971](https://arxiv.org/abs/2609.22971)

### 4. Simulated users help find issues, not judge taste

- **UXCascade** (Holter, Koh, Dogan, Chan; ETH Zurich and Adobe; UIST '26, 2–5 Nov 2026): persona agents browse a
  site, their traces are aggregated into issues, a fix is replayed. Study with 8 UX professionals: on par with human
  feedback, but *against a deliberately minimal baseline*. Their own limits: agents showed **significantly lower
  variability** in clicks than humans, and the browser agent "consistently struggles" with visual cues and can't judge
  visual appeal or natural layout. Their proposed next step is the useful part: replay only the personas a change
  affects, as a UX regression test. [doi.org/10.1145/3830398.3830609](https://doi.org/10.1145/3830398.3830609)
- **RELIEF** (Li, Gao, Wu et al., arXiv 2610.26636, 19 Oct 2026): a coding agent revises generated UIs from four kinds
  of critique (code reading, automated interaction, written human feedback, recordings of real people using it);
  critiques from **recordings of real use gave the largest usability gains**. 200 sites, 355 recordings, 24 users.
  [arxiv.org/abs/2610.26636](https://arxiv.org/abs/2610.26636)
- **persona-lab** (open source, 2026, Android): LLM personas use the real app on an emulator with no access to source;
  the *engine* then reads what the app stored and labels each need `verified` or `overclaimed`. On six planted
  defects, personas reported 3 of the 4 they reached; one session cost $6.61. A tool, not a study: "Simulated personas
  are not users." [github.com/Maleckidd/persona-lab](https://github.com/Maleckidd/persona-lab)
- **AdaptiTest** (arXiv 2611.05873, 4 Nov 2026): an LLM mobile GUI tester that keeps scoped, revalidated "experience"
  of past runs completed 18/18 runs vs 3/18 without it, on a six-task subset; the authors say this is a case study,
  not general efficacy. [arxiv.org/abs/2611.05873](https://arxiv.org/abs/2611.05873)

### 5. Accessibility and load

- **SeeR** (arXiv 2611.02410, 2 Nov 2026): grouping a mobile screen by function for screen readers cut
  non-informative focus stops by 82.1% and navigation steps by 52.7% vs TalkBack (10 blind and low-vision
  participants). The lesson for builders: grouping controls by what they do is accessibility, not just layout.
  [arxiv.org/abs/2611.02410](https://arxiv.org/abs/2611.02410)
- Apple's `XCUIApplication.performAccessibilityAudit()`, run at default and largest text size, is what practitioners
  use as the cheap automatic gate (one developer's audit, 16 Oct 2026, caught Dynamic Type and contrast failures, and
  noted VoiceOver order still needs a hand check). Opinion, single case.
- A 2026 *Electronics* paper on cognitive load of AI-designed UIs (raw generated UIs: highest load, 63% task accuracy
  vs 100%) surfaced in search but I could not open it: unverified.

### 6. Industry numbers (secondhand)

- Sourcegraph's 2026 survey (1,028 people): 54% estimate that more than 60% of AI-generated work needs significant
  rework before release; BairesDev Q3 2026: 51% of developers spend over a quarter of their week reviewing AI work.
  Both seen through search excerpts only: unverified, and not UI-specific.

## What practitioners recommend (opinion)

- **Design system as guardrail, with two separate jobs** (Evil Martians, 23 Sep 2026): one agent skill to *use* the
  system to build screens, another to *change* the system; a screen build that hits a missing component logs it in a
  **gaps journal** and works around it, never edits the system in passing. Component contracts (purpose, when not to
  use, behaviour, accessibility duties), inventories to shortlist from, a lint that fails on raw hex, exceptions that
  need a written reason. No measured results. [evilmartians.com](https://evilmartians.com/chronicles/ai-makes-design-system-guardrails-mandatory-this-framework-delivers-them)
- **Every screen in its unhappy states** (21st.dev, 21 Aug 2026): generated components render the happy path; check
  loading, empty, error and permission states and each control's states. No data behind "most". [21st.dev](https://21st.dev/blog/ai-generated-ui-review-checklist)
- **Screenshot-driven SwiftUI loop** (Trevor Whittingham, 1 Jul 2026): a named preview or debug route per state
  (happy, empty, locked, long text, largest Dynamic Type, dark), seeded fixtures with stable ids, a repeatable shot
  script, one targeted change per look; keep the harness afterwards; snapshot tests only for a few stable,
  high-value components, since pixel snapshots are brittle across OS and fonts. [theswift.dev](https://www.theswift.dev/posts/give-your-coding-agent-eyes-screenshot-driven-swiftui-iteration/)
- **iOS agent practice** (Blake Crosley, guide updated 25 Nov 2026; 8 apps, 293 Swift files): configuration beats
  prompting; build and test results are the primary check; visual polish, layout, signing and performance stay human.
  [blakecrosley.com](https://blakecrosley.com/guides/ios-agent-development)
- **Dogfood from runtime only** (Callstack's `dogfood` skill for `agent-device`): explore core journeys plus empty,
  error, loading, offline and permission-denied states; findings must come from observed behaviour, *never from
  reading the source*; each behavioural issue needs a repro video and step screenshots; "Repro quality matters more
  than issue count." [skills.cat](https://skills.cat/skills/callstackincubator/agent-device/dogfood)
- **Platform support**: Xcode 26.3 (Apple, 3 Feb 2026) lets Claude Agent and Codex capture Xcode Previews to check
  their own work, over MCP. [apple.com/newsroom](https://www.apple.com/newsroom/2026/02/xcode-26-point-3-unlocks-the-power-of-agentic-coding/)
- **Figma Code Connect** (vendor case, Coinbase: about 22% faster implementation, 11.5% fewer tokens): relayed by
  blogs, unverified. Same theme: map design components to real code components so the agent can't improvise.

## Failure modes of AI-built UI, as seen across these sources

| Failure | Caught by |
|---|---|
| Looks like the design, behaviour missing or stubbed (button toggles, nothing saved) | Task run checked against stored state (Anthropic, persona-lab, WebUIProof) |
| First screen right, later screens and navigation drift | Fidelity pairs for *every* state, not the landing one (Vision2Web) |
| Phone layout worse than wide layout | Shots at the real device size only (Vision2Web) |
| Agent says it did something it didn't | Never accept the builder's account; a separate checker or script (Design Theater, Anthropic) |
| Missing empty, error, loading, offline, permission states | A named state per screen, in the pair set (21st.dev, Whittingham, Callstack) |
| Drift from tokens and components, one-off styles | Lint plus component contracts plus gaps journal (Evil Martians) |
| Reviewer agent approves what it found broken | Hard thresholds; calibration on the owner's past verdicts; a skeptical prompt (Anthropic) |
| Pretty but heavy: too many elements, unclear focus | Human judgment; models weakest here (UXCascade, Vision2Web judge 0.66) |
| Screen reader and text size breakage | `performAccessibilityAudit` at two text sizes, VoiceOver by hand on key screens |

## The recommended workflow

1. **Spec as states, not screens.** Every screen is a list of named states (data, empty, loading, error, offline,
   long text, largest text). Each state has made-up fixture data shared by the design and the app.
2. **Guardrails before screens.** Tokens and components carry the rules; a lint fails on raw values; a screen build
   that needs something the system lacks logs a gap and stops, never invents.
3. **Builder agent works in small batches, by component,** and leaves its harness behind (debug route, fixture,
   shot).
4. **Script pairs every state** (design vs app, same data, device size), with a deterministic text and box diff before
   any model looks.
5. **Separate checker runs tasks** on the running app against a fake backend and checks *stored outcomes*, plus the
   accessibility audit. It sees the app only, never the source, and has hard pass/fail thresholds.
6. **A fresh, calibrated visual reviewer** scores pairs, comparing two images rather than scoring one, tuned on the
   owner's past yes/no calls.
7. **The human sees one prepared page at a fixed time**: pairs that changed, task recordings that matter, scores.
   Their call is taste and load. Anything they flag becomes a new row (state or task), then the fix.
8. **Done** = pairs match, tasks pass, audit passes for every touched state; then one live run on real data.

## Where the evidence is thin

- No 2026 study yet measures AI-built *native mobile* apps against real users; almost all benchmarks are web.
- Simulated users are validated against minimal baselines, with less behavioural variety than people.
- Visual judges agree with humans moderately at best; their aesthetic judgment is the weakest part.
- Nothing measured shows how often a human should review; the cadences above are practice, not results.

## For Life: what should change

The setup: a solo owner, a SwiftUI iPhone app built by Claude Code agents, the approved prototype
(`docs/design/chat-first/prototypes/shell.html`) as the spec, the parity plan
(`~/Work/life-wt/app-parity-plan/docs/plans/2026-11-26-app-matches-prototype.md`, strategy D), and "done means ran
live + screenshot vs prototype".

Strategy D is what the evidence points to: pairs as data, rerun on every UI change, fixes grouped by component, the
owner off gap-hunting. Its fake Life with the prototype's own data, the DOM-box text diff (`scripts/design-compare.ts`)
and the "no design" rows routed to the Designer session are exactly layers 2 and the gaps journal. What it lacks:

1. **A "works" column beside "looks".** The board measures fidelity only, and VISTA and Vision2Web show fidelity and
   behaviour diverge. Give each prototype scenario a task (goal, taps, expected result) that `agent-device` runs on the
   fake Life, and have **the fake Life record what the app sent** (the answer, the send, the undo), so code checks the
   outcome, not the agent. A row is green only when both columns are.
2. **Count the steps.** For each task, the taps in the app vs in the prototype. A pair can match while the path to it
   grew by two taps; that is the cognitive-load drift the owner cares about, and it is a number, not an opinion.
3. **Unhappy states as rows.** Add empty, slow, offline, failed send, long name, largest Dynamic Type for the item row,
   the unfolded ask and the thread. The prototype draws some; where it draws none, the row is "no design", not a
   builder's guess.
4. **The reviewer never sees code and never takes the builder's word.** The fresh-eyes reviewer gets the pair and the
   task recording only; a builder's "matches" counts for nothing until the script's row says so (Design Theater: 25–34%
   of stated work absent). Calibrate it on today's six reviews and the owner's past verdicts, with hard thresholds.
5. **Add `performAccessibilityAudit`** to the handful of XCUITest journeys, at default and largest text size. Cheap,
   deterministic, and the current plan has no accessibility check.
6. **Keep pixel snapshots narrow.** A few stable components only (the item row, the ask card); the pairs carry the
   rest. Snapshotting everything is brittle maintenance for no extra signal.
7. **Narrow the owner's part to taste.** His 5 minutes on the board is the right job: models and simulated users are
   weakest on aesthetics and load. Show him only rows that changed since he last looked, with the step count beside
   each, and turn anything he flags into a row before any fix.
8. **Done, restated:** the touched rows green in both columns, the audit passing, then one live run on his real Life
   (keep it: real data is the final verifier). The live screenshot is then a confirmation, not the search.
9. **Persona agents: later, not a gate.** A weekly `dogfood` run (Callstack's skill, `agent-device` is already
   installed) over the fake Life, runtime-only, repro video per finding, is worth having for exploration. It should not
   decide "done".

Not worth doing now: training or fine-tuning a judge (uxCUA, RELIEF), Figma pipelines (the prototype is HTML and
already the spec), a simulated-persona study.
