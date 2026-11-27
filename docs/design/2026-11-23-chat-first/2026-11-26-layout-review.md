# Layout review, v4.1 (PR #1407), 26 Nov 2026

A fresh review of the layout stage against `2026-11-25-app-v4.html`, the current spec, `docs/brand.md`, the owner's 11
answers and the catalog and navigation reviews. Live screens: `v41-layout` merged with `v41-e2e` in a detached
worktree, Debug build, a fresh iPhone 18 Pro clone (iOS 27.2), scenario C1 (Send a draft) and the catalog, at the
default text size and at accessibility XXXL. Screens are in `2026-11-26-screens-layout-review/`.

**Verdict: fail.** Two must-fix items, both about the thread's edges.

## Must-fix

| # | Where | What | Seen | Fix |
|---|---|---|---|---|
| M1 | Thread, keyboard up | At AX XXXL, focusing the field leaves the unfolded ask's draft and answers under the field and the keyboard: the thread doesn't keep its bottom when the keyboard shrinks it (`defaultScrollAnchor(.bottom, for: .sizeChanges)` doesn't take, or it fights `contentMargins(.bottom, fieldHeight)`). At the default size it only works because the content is shorter than the view. | `13-keyboard-ax.png` (compare `12-ask-unfolded-ax.png`), `14-keyboard-default.png` | When the keyboard shows (or `fieldHeight` changes) and he was at the end, scroll to `"end"`. Test it with a thread taller than the screen. |
| M2 | Thread, top | The thread scrolls under the two round buttons with no clearance and no fade. Text runs into them: his bubble sits under "1" and the Pendant button at AX, and the day separator lands between the buttons at the default size when the keyboard is up. The prototype's thread starts below the buttons (`.thread{top:110px}`). | `12-ask-unfolded-ax.png`, `14-keyboard-default.png` | Clip or fade the thread under the top inset, like the field at the bottom: a scroll edge effect or a soft mask for the height of the buttons. |

## Should-fix

| # | Where | What | Seen | Fix |
|---|---|---|---|---|
| S1 | Thread rhythm | The spacing is about twice the prototype's. Entries are 24 apart (`Spacing.xl`) and the space inside an entry is 12, against the prototype's single `gap:12px`. The separator to his bubble is about 26 pt (prototype about 12). The last row to the field is about 43 pt (prototype 22): the bottom padding `l` plus the stack's `xl` before the 1 pt `"end"` marker. | `03-count-answer-default.png` vs `00-prototype-thread.png` | Use 12 between entries; drop the stack spacing before `"end"` (or the bottom padding). |
| S2 | Day separators | Shows "Wednesday, Nov 18"; the prototype shows "Yesterday" and "Today". The type is `.line`; the prototype's is 12 px. | `03-count-answer-default.png`, `00-prototype-thread.png` | Relative day names for today and yesterday, the weekday within a week, then the date. |
| S3 | Empty thread | "Ask me anything." is centred in the middle of the screen. Nothing decided asks for it: the prototype's empty thread is blank, and the spec gives the empty state to the field's suggested asks. A middle-of-screen line also goes against a thread that opens at its bottom. | `01-thread-draft-default.png`, `10-empty-ax.png` | Remove it, or get it decided and place it where the first words land, at the bottom. |
| S4 | Soft wash, live | `washed` reaches only the design-system pieces (`ThreadItemRow`, `AskCard`). The live thread's `Items/ItemRow` doesn't use them, so an unfolded ask in the app has no wash at all (pixels 0,0,0) and keeps a hairline. Probably the assembly stage's, but the PR claims the wash. | `04-ask-unfolded-default.png` | Say so in the PR, or move `ItemRow` onto `ThreadItemRow` and `AskCard`. |
| S5 | Soft wash, catalog | The fade still has a hard top edge and a hard left edge (it steps from 0 to about 5–6 of 255 at once), which is clearly a box at AX. `EllipticalGradient` from (0.35, 0.4) at 0.65 is still near full strength at the top edge; the prototype's `farthest-side` is about a third of full strength there. It is 5% against the prototype's 6% (see nit N1). The 4 pt gap on the left is the catalog's 393 pt column on a 402 pt screen, not the wash. | `05-catalog-items-default.png`, `08-catalog-items-ax.png` | Match `farthest-side`: a radius that reaches 0 at each edge, or pad the wash so that it does. |
| S6 | Streaming follow | `onChange(of: thread.entries.count)` sets `followsEnd = true` and scrolls to the end for every new entry, so a late reply or a follow-up card arriving while he reads further up pulls him down. The spec allows following only when he is at the bottom. | code, `ThreadView.swift` | Follow on a new entry only when the entry is his own, or when he is already near the end. |
| S7 | Answers at AX (live `ItemRow`, assembly) | The three answers stay in one row, and Later is cut to "Lat…". The catalog's `AskCard` already wraps them (Yes full width, then No and Later). | `12-ask-unfolded-ax.png` | Fixed when assembly moves onto `AskCard`; track it there. |
| S8 | His bubble's reaction mark at AX (catalog, components) | The mark sits behind the grown bubble and is cut in half (the eyes, the thumbs up). | `09-catalog-thread-ax.png` | Put the mark above the bubble and give it room; for the components stage. |

## Nits

- N1: `Palette.wash` is 5%; the prototype's `.inplace` is 6% (and the catalog review quoted 6%).
- N2: The bubble's widest is 300; the prototype's is 286. Its padding is 12 and 8; the prototype's is 14 and 10.
- N3: Show earlier is plain heading text; the prototype draws a quiet `tint` pill 32 pt high. Its anchor
  (`scrollTo(top, .top)` in a `Task`) keeps the old first entry at the top, so the view jumps by the button's height.
  I couldn't run it live: the fixtures' threads are shorter than one page.
- N4: Profile: the sections are 24 apart and the lines inside them 8; the prototype uses 18 and 6. The 20 pt gutter
  matches the prototype (`.pscroll` 20). I couldn't see it live: the mock answers C1's deep link to `person:test-ana`
  with "Life didn't open it." (`15-profile-default.png`, `16-profile-ax.png`). The e2e mock needs a person read.
- N5: "One gutter" holds for the thread, the field, the notices and the wash (16, `threadGutter`), next to
  `Metrics.gutter` (20) for the profile. That matches the prototype, but the doc comment on `gutter` ("every page")
  is now wrong.
- N6: At AX the item disc's glyph is larger than its 40 pt disc (`08-catalog-items-ax.png`); for the components stage.

## What holds

- The field's clearance: at rest the last row stays above the field at both sizes, and `contentMargins` doesn't
  double the field's safe-area inset (gap measured at 43 pt, see S1).
- The bubble width scales with the text size (`@ScaledMetric`): at AX it wraps inside the screen with no clipping.
- The day separators are headers to VoiceOver; the profile's name and line are centred and wrap.
