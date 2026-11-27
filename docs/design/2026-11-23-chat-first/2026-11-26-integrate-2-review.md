# Integrate 2 review (PR #1414, head 17299d473)

Fresh design review of what PR #1414 draws on the iPhone, against the only approved reference: the v4 prototype
(`origin/main:docs/design/2026-11-23-chat-first/2026-11-25-app-v4.html`) and `docs/brand.md`. The design lab was not used.

**Verdict: fail.** Of the six items, only the quick edit chips' look at the default size matches. Four items differ
from the prototype, and two are clipped or broken at the largest text size.

## How it was checked

- Prototype: one headless Chromium (reduced motion, animations and transitions at 0s), its v4 states: "How am I
  doing?" before, just after and settled after a pick; long work (thinking, "About 10 min left"); the result landing
  later; the Jade draft, a tapped quick edit, a typed redraft; the beads order table. Closed afterwards.
- App: built Debug from the worktree, run on a fresh iPhone 18 Pro (iOS 27.2) made for this review and deleted
  after it. Scenario C20 (rating), the Debug catalog (`thread`, `asks`), and three scratch scenarios on the existing
  wire fixtures (`read_thread_handed`, `read_thread_late_reply`, `read_thread_draft` with three edits). Default text
  size, then the largest (accessibility XXXL).
- Screenshots in `2026-11-26-screens-integrate-2-review/`, app on the left, prototype on the right.
- Tooling note: driving the simulator with `agent-device` failed first (its session would not attach to the app,
  `SESSION_NOT_FOUND`); everything after that was driven and shot through `argent`. The text size was set with
  `simctl ui content_size` (argent has no such tool).

## Must-fix

1. **"How am I doing?" only shows inside the unfolded ask, under the field** (`rating-clipped-default.png`,
   `rating-default.png`). The prototype puts the row in the thread, as its own item right under the settled row, with
   no tap needed. The app draws it in `ItemRow.detail`, so he sees it only after unfolding a settled ask, and the
   unfolded row lands under the Ask Life field (clipped). C20 has to swipe up to reach it.
2. **After a pick the row vanishes** (`rating-after-pick.png`). The prototype keeps the row: the other marks and
   the cross fade out, the picked mark stays a little larger, the words become "Thanks", then the whole row dims to
   0.45. The app removes the row with nothing shown.
3. **Handed work is a bare line, not the under-way item** (`handed-default.png`). The prototype shows a row: the
   work's round icon, its title ("Find a physio for this week"), then the line ring + "About 10 min left · Undo".
   The app draws only the pie and the time, with no title and no Undo, so he cannot tell what is running or stop it.
4. **The pie is a filled wedge, not a ring** (`steps-handed-default.png`, zoomed in the catalog). The prototype's
   `pieSVG` and brand.md ("a still ring that fills at each milestone") call for a ring: a faint track and an arc.
5. **A late reply is drawn under its old ask, with no lead** (`late-reply-default.png`). In the prototype a result
   that comes later lands at the bottom of the thread when he is free, led by a line that links back ("The physio
   search is done:"), with the down pill if he scrolled up. The app puts the reply text directly under the earlier
   answer: up the thread, where he may never see it, and it reads as part of the first answer.
6. **A tapped quick edit does not change the draft in place** (`quick-edit-tap.png`). The prototype changes the
   draft where it is: the tapped chip shows a small spinner, the new text inks in, that chip goes, and a back arrow
   appears in front of the others. The app sends the chip as his words: a "Warmer" bubble lands at the bottom and the
   ask is asked again under it, while the old draft stays open with all three chips. (A typed change, `edit:words`,
   bubbling and re-asking is right: it matches the prototype's redraft.)
7. **Quick edit chips break mid-word at the largest text size** (`quick-edits-largest.png`): "War/mer",
   "Shor/ter", "Frenc/h" in round blobs. They should wrap whole to a new line, like the prototype's `flex-wrap`.
8. **The table is not the prototype's table** (`table-default.png`, `table-largest.png`). The prototype's is full
   width: the label column left, numbers right-aligned in tabular figures, a hairline between rows, group headings,
   muted notes after a value, and a bold "Total" row over a stronger rule. The app's has two narrow columns side by
   side, no rules, numbers not aligned to the right, and a bare "7" with no "Total" label.
9. **The thinking step has no words and no thinking mark** (`steps-handed-default.png`). The prototype shows its
   three-dot thinking mark and "Thinking…" (shimmering, still under reduced motion). The app's `StepsLine()` shows a
   spinner alone.
10. **The top fade hides most of the thread** (`quick-edits-hidden-by-top-fade.png`, also visible on every app
    screenshot). On `main` already (RootView's top inset has `.frame(maxHeight: .infinity)` before its height is
    measured, so `topHeight` is the whole remaining screen and the mask fades out about the upper two thirds of the
    thread). It is not this PR's code, but it hides this PR's items: a draft's chips scrolled to the middle of the
    screen are invisible. Measure the inset before the frame.

## Should-fix

- **The steps line's object is not bright.** The prototype has the verb muted and the object in `fg`, weight 600
  ("Looking at **your calendar**"); the app draws both muted.
- **Spinners in the steps line are in the `ai` blue**; the prototype's are muted (`currentColor`).
- **The ring and spinners do not grow with the text** (`handed-largest.png`, `steps-handed-largest.png`): at the
  largest size they are a dot beside very large words.
- **Rating marks touch each other at the largest size** (`rating-largest.png`); the cross sits against the 🤩.
- **The time before the first milestone**: the prototype says "About 20 min", then "About 10 min left"; the app
  always says "left". Minor, but "left" on a task that just started reads oddly.

## Nits

- The catalog's table puts "#420" under the heading "Bags" and the counts under "Seed": the headings are swapped
  against the prototype's (label column, then the unit).
- The catalog section for the rating says "a tap on one closes the row", which is the behaviour of must-fix 2.

## What matches

- Quick edit chips at the default size: right-aligned under the draft, the tint pill, 13-ish semibold muted words.
- The rating pill's shape at the default size: card capsule, muted "How am I doing?", the three monotone marks and a
  faint cross.
