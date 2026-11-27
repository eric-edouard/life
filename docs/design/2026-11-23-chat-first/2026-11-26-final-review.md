# Final design review, v4.1 chat-first iPhone app (origin/main edd33d542)

Judged against, in order: the approved prototype (`2026-11-25-app-v4.html`), the rulebook
(`2026-11-26-original-components.md`, "Start from his seat" and "The owner's answers" first), `docs/brand.md`, and his lab
decisions (`origin/v41-design-cards:docs/design/2026-11-23-chat-first/2026-11-26-lab-decisions.md`).

**Verdict: fail.** The rating, the top fade, Reduce Motion, the pairing sheet and the generated pages hold. The slow answer
empties the thread for seconds, and the unfolded ask, the notice and the row's faces still differ from the prototype.

## How it was checked

- App: Debug build of the worktree, installed on a fresh iPhone 18 Pro (iOS 27.2, not a Duo) made for this review and
  deleted afterwards. Driven only through `argent` (launch-app with the e2e arguments, describe, gesture-tap/swipe,
  screenshot, screen recording). Scenarios: M1 (slow answer, rating), P1 (person and matter pages), C1 (waiting list,
  unfolded ask), O2 step 1 (Mac out of reach: the notice), S1 (pairing by link), plus one scratch copy of P1 with a
  `life:pictures` block (not committed). Reduce Motion set through the simulator's accessibility defaults; the largest
  text size through `simctl ui content_size accessibility-extra-extra-extra-large`.
- Prototype: headless Chromium at phone size, its own scenario buttons (waiting, rate, async, offline, mac, pendant,
  house).
- Screens: `2026-11-26-screens-final-review/<name>.png` is app (left) beside prototype (right); raw shots in `app/` and `proto/`;
  recordings `app/m1-slow-answer.mp4`, `app/reduce-motion-m1.mp4`, `app/person-open.mp4`.
- The Mac's load was 17 to 170 during the run (other sessions); timings below are what the simulator showed.

## Must-check results

| Check | Result | Screen |
|---|---|---|
| Rating row: tap a mark, it dims and says "Thanks" | **Pass.** The picked mark stays, the others and the cross go, "Thanks", the row dims. | `rating-settled.png` |
| Profile opened from a face (zoom) | **Not verified.** No shipped scenario shows a face that opens a profile: the ask row's face is a mark, and a `life:pictures` block drew nothing because the fake Life never names the party. Opened from a link (P1), the page arrives with a cut, no zoom (`app/person-open.mp4`). | `person-page.png` |
| Slow answer: ink-in, thinking shimmer, thread never empty | **Fail.** "Thinking…" with its dots shows, then the steps line, and words ink in. But for about 4 to 8 s mid-answer the whole thread is blank: his bubble, the date and the answer all scroll out of view under the field, then come back once the answer ends. Seen in two recordings and ten straight screenshots. Under Reduce Motion it does not happen (one blank frame only). | `slow-answer-empty.png`, `slow-answer-thinking.png` |
| Top fade | **Pass.** Only the strip under the round buttons fades; every row below is fully visible. | `top-fade.png` |
| Reduce Motion | **Pass.** The edge holds still (no pixel change between idle frames), the answer appears word by word with no blur or slide. | `app/reduce-motion-m1.mp4` |
| Notice at the largest size | **Fail.** The Mac mark hangs outside the 16 pt gutter at the screen's left edge, with no disc; unfolded, the notice scrolls up under the status bar and the round buttons vanish. | `notice-xxxl.png`, `notice-xxxl-open.png` |
| Pendant at the largest size | **Pass, with a nit.** Everything wraps and scrolls; the floating "Replace this pendant" stays clear once scrolled. | `pendant-xxxl.png` |
| Pairing sheet at the largest size | **Pass, with nits.** Fits and wraps. | `pairing-xxxl.png` |
| Person and matter pages from their readings | **Pass.** Markdown (a paragraph and a dated list) from the reading, the live "needs you" ask row above it, reach below, no fixed sections, no "Writes". | `person-page.png`, `matter-page.png` |

## Must-fix

1. **The thread goes blank mid-answer** (`slow-answer-empty.png`). While a slow answer streams, the scroll position runs
   past the content, so for several seconds the screen shows only the edge, the round buttons and the field. The
   prototype keeps his bubble and the growing answer in view the whole time (`batchFollow`, the top kept in view).
2. **The steps line stays after the answer starts** (`steps-line-stays.png`). "Reading your asks" with its spinner stays
   above the finished answer. In the prototype the line blurs away and the words ink in where it was.
3. **The unfolded ask is not the row grown** (`ask-unfolded.png`). The header keeps the row's size (no 48 pt face, no
   19 pt title), there is no wash and no ⌃ fold, and a second title ("Send Kit the message?") sits under the row's own
   title ("Ask Kit"), so one fact is said twice. The quiet pills put "Wait" before "Later"; Later is always the first
   quiet pill.
4. **A person's face is a speech-bubble mark** (`waiting-row.png`, `person-page.png`, `matter-page.png`). Kit Moreau's
   ask shows a chat mark. The rulebook's faces rule: a person is their initial (or picture); a mark only when there is
   no one to show.
5. **The notice at the largest size** (`notice-xxxl.png`, `notice-xxxl-open.png`): the mark leaves the gutter and its
   disc; unfolding scrolls the notice under the status bar and hides the round buttons. The time belongs in the line
   too, not the title: the prototype says "Your Mac isn't answering" over "Nothing is lost · since 14:10".
6. **The idle field shows a cancel cross and has no suggestions** (`waiting-row.png`). The prototype's idle field is one
   capsule: "Ask Life or hold to talk", the microphone, a faded Send, and Life's three likeliest asks inking in turn.
   The cross belongs only to listening.
7. **A settled row trails a green tick; a needs-you row trails a coral dot** (`rating-settled.png`, `waiting-row.png`).
   Nothing trails a row but the Later pill: the tick goes into the line ("✓ Sent to Kit"), and "today" in coral already
   says it is urgent.
8. **The rating repeats under every answer** (`top-fade.png`). Asking "What's waiting on me?" again draws a second "How
   am I doing?" row. At most one rating a day.

## Should-fix

- The person page's face is a flat grey disc with a muted initial; the prototype lifts it to 104 pt on the person's hue,
  with a cream initial.
- The matter page opens as a grey half sheet with its own title while a person opens as a full page: two shapes for
  one kind of page. It also has no "Ask about this…" field.
- The pendant screen says "Unknown" twice (battery, storage) while not connected: every fact once.
- The pairing sheet has a "Pair" headline (no prose titles) and both a ✕ and a "Cancel".

## Not built yet (picked today, not failures)

Voice naming A v2, new matter C v2, is this done B v2, same person C v2, Contacts card A v2, at an organization A v2,
payment code A, link B v2, event A, paid search A, planned steps C v2, Life sees it done C, clip on a card C v2, focused
list sideways A, add to calendar B v2, paid run A, looks for it done A, change draft by words A, a late reply A, on it
with an estimate A, Life's mark on a message A, settings 1 C, 2 B, 3 A, the pendant's screen D, and the failure states
("Not sent", "May have gone", "Already answered"). None of these was judged.
