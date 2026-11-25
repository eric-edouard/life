# Design system catalog: review on a standard iPhone

Review of PR 1400's component catalog (`-catalog <page> <offset>`, Debug) on an iPhone 18 Pro simulator, iOS 27.2,
402 pt wide, against the app v4 prototype ([`prototypes/shell.html`](prototypes/shell.html)), `docs/brand.md`,
`assets/brand/tokens.css` and the owner's 11 answers in
[`2026-11-25-app-v4-design-system.md`](2026-11-25-app-v4-design-system.md). Worktree head `e544d98e7`.

Screens are in [`screens-ds-review/`](screens-ds-review/): `app-<page>-<offset>.png` from the simulator (offset in
points; blank overscroll shots dropped), `app-aura-<state>.png` for each aura state, and `proto-<scenario>.png` from
the prototype's app v4 scenarios at phone size (390 × 844, Chromium).

**Count:** 5 must fix, 16 should, 8 nits.

## Findings

| # | Component | State | What differs | Prototype vs app | Severity | Fix, in plain words |
|---|---|---|---|---|---|---|
| 1 | Ask card | Spending stop | An answer is cut off: "Keep loo…" | Prototype: the recommended answer full width on its own line, the others in a row of two under it (`proto-budget`). App: three equal pills in one row, so a long answer truncates (`app-asks-0`) | must fix | Lay answers out as the prototype does: the recommended one full width, the rest two to a row; never truncate an answer |
| 2 | Aura (edge) | No Mac | The still edge is a blue ring, so "no Mac" reads like "Life is working" | Prototype `still`: cream at 5%, no blue at all. App: a dim Life-blue ring (`app-aura-no-mac`, next to `app-aura-working`) | must fix | Draw the still state in cream only, fainter than idle; blue belongs to Working alone |
| 3 | Notice | Open | A button with a word, "Settings", full width | Owner's answer 8: words only on ask answers, question answers, a confirm's two choices and quick-edit chips. Prototype offline notice: disc + title + line, then the settings block itself in place (`proto-setoff`). App: a quiet pill "Settings" (`app-thread-600`) | must fix | Show the notice's settings in place (the settings block), or a round icon button; no word on the button |
| 4 | Settings block | Switch on | The on switch is system green | Prototype: on is a cream track with a black knob (`proto-setall`, `proto-setoff`). App: iOS green (`app-settings-0`); green means "it worked" (`ok`), so colour is used without meaning | must fix | Tint the switch `fg` with an `on` (black) knob; keep green for the tick only |
| 5 | Still ring / Thread item | Under way | The ring reads as a spinner: a blue arc on an almost invisible track | Owner's answer 4: "a still ring for long work, never a spinner". Prototype: a small muted pie before the estimate. App: an 18 pt Life-blue arc, `tint` track barely visible, at the row's trailing edge (`app-blocks-0`, `app-items-0`) | must fix | Draw it as a filled pie (or a ring with a visible track) in `muted`, before the estimate line, so it never looks like it turns |
| 6 | Ask card | Busy | Busy looks disabled: the Send pill goes grey with no spinner, Later fades | Prototype `.prim.busy`: full opacity with the spinner. The catalog's own busy button (blocks page) does show it. App: `app-asks-0`, last card | should | Reuse the busy pill style: keep Send filled with its spinner; only the other answers dim |
| 7 | Ask card | All | Each ask sits in a rounded card | Prototype: "no cards"; an ask sits on a faint wash with no edge, full bleed, with a header (disc, title, line) (`proto-asyncdone`, `proto-draft`). App: `card` fill, radius 18 (`app-asks-0`) | should | Put the ask on `wash` with no visible shape, or confirm cards are the new decision and amend the spec |
| 8 | Ask card | With a draft | The draft is a plain grey box: no chat, no recipient, no app colours | Prototype: the chat header (app mark, name, Open WhatsApp), the last messages, the draft as a bubble in the app's colours (`proto-draft`, `proto-wa`). App: text in a `tile` box (`app-asks-0`). `DraftBlock.swift` exists but is not in the catalog | should | Use `DraftBlock` in the ask card and add it to the catalog in each state (WhatsApp, Messages, rewriting) |
| 9 | Quick-edit chips | Rest | Left-aligned, in `fg` | Prototype `.qe`: right-aligned under the draft, muted text (`proto-draft`). App: left, cream (`app-asks-0`, `app-blocks-0`) | nit | Align the chips to the trailing edge under the draft, text `muted` |
| 10 | Thread item | Unfolded | A rounded card, and the ask inside is indented a second time | Prototype `.inplace`: a radial wash with no edge, radius 0, bleeding to the screen edges; content on the same left line as the rows. App: `card` with radius, the ask's question 16 pt right of the item title (`app-items-0`) | should | Use the wash full bleed with no corners; drop the ask's own padding when it sits inside an item |
| 11 | Thread item | All rows | Hairlines between rows, and no disc | Prototype v4 rows (`.fr`) are bare, with a 40–44 pt disc (icon or initial) at the start (`proto-meetend`, `proto-rate`). App: hairlines between every row, no disc (`app-items-0`) | should | Drop the dividers; add the row's disc |
| 12 | Thread item | Needs you | The flag dot is large | Prototype: 7 pt dot. App: about 12 pt (`app-items-0`) | nit | 7 pt |
| 13 | Thread item | Outdated | Struck through | Prototype: the row at 35–40% opacity, no strike (`.fr.outdated`, `.fr.old`). App: strikethrough (`app-items-0`) | nit | Fade the row; drop the strike |
| 14 | His bubble | With 👀, with 👍 | The reaction is inline at the end of the words | Prototype: a 24 pt round mark on the bubble's bottom-left corner (`proto-budget`). App: inside the bubble after the text (`app-thread-0`) | should | Move the reaction to a corner mark outside the text |
| 15 | How am I doing? | Rest | No surface: the row floats | Prototype `.hd`: a `card` pill (radius 24) holding the question, the three marks and the cross (`proto-rate`). App: bare row (`app-thread-0`) | should | Put the row on the `card` pill |
| 16 | Sent line | Deleted | The whole line is green | Prototype: a small green tick, the words in `muted` (`.okt`). App: "Deleted for both of you" in green (`app-thread-600`) | should | Green tick, muted words |
| 17 | Spinner (Undoing, busy chip) | Busy | The arc is Life blue | Prototype `.spin`: `currentColor` (cream or muted). App: blue arc (`app-thread-600`, `app-blocks-0`) | nit | Draw the spinner in the text's colour |
| 18 | Held separator | Rest | Rules drawn either side of the words | Prototype `.sep.held`: centred muted words, no lines (`proto-meetend`). App: hairlines left and right (`app-thread-600`) | should | Remove the rules |
| 19 | Notice | Closed and open | A card with a 19 pt title and no icon; a big gap before the message | Prototype `.sys`: disc icon, 16/650 title, 13.5 muted line, no card (`proto-setoff`). App: `app-thread-600` | should | Use the row shape: disc, row title, line |
| 20 | Round buttons | Rest | A light rim around each glass circle; 57 pt wide | No borders (brand); prototype controls are 36–40 pt with only a faint inner light. App: system glass rim reads as an outline (`app-blocks-0`) | should | Use the app's own `glass` fill without the system rim, at the prototype's size, or confirm the system glass is accepted |
| 21 | Settings block | Appearance | Offers Auto and Dark | Owner's answer 11: dark only for now. App: an Auto pill that does nothing different (`app-settings-0`) | should | Drop Appearance until light mode exists |
| 22 | Settings block | Rows | Row titles 16 pt, value pills 44 pt tall | Prototype: 15/600 titles, value pills 38 pt at 13.5/650 (`proto-setall`). App: `app-settings-0` | nit | Use the line steps the prototype uses, or accept the larger size on purpose |
| 23 | Aura picker | Colours | Only 7 of 10 colours fit; Orchid, Silver and Cream are off screen with no hint | Prototype: the swatches wrap onto two rows, with the chosen colour's name under them (`proto-setall`). App: one horizontally scrolling row (`app-aura-0`) | should | Wrap the swatches, and show the chosen name |
| 24 | Aura picker | State | System segmented control (grey selection) | Prototype `.seg`: selected segment in `fg` with black text. App: `app-aura-0` | nit | Style the picker with the brand's selected pill, or accept the system control |
| 25 | Values | Colour swatches | `on` (black) is invisible on the black page | App: `app-values-0` | nit | Show `on` on a `fg` chip so it can be seen |
| 26 | Catalog section titles | Thread | The 👍 in the title is in colour | Owner's answer 6: monotone emoji in Life's interface. App: `app-thread-0` heading | nit | Use the monotone mark (or words) in the title |
| 27 | Catalog launch | Any page | Launching the catalog raises the Focus-status permission prompt over it, and the start offset can scroll past the content into blank space | App: the prompt covered `app-values-600` until dismissed | should | Skip the app delegate's permission requests when `-catalog` is set; clamp the start offset |

## What matches

- The type scale: every step seen is one of the seven sizes at 450, 600 or 650 (`Typography.swift`, `app-values-0`).
- The tokens and the aura palette: the 13 tokens plus `tint`, `glass`, `wash`, and the ten aura colours, as listed.
- Radii: 12, 18, 22 and the pill, shown on the values page; buttons are full pills.
- The filled, quiet, done (green with a tick) and disabled buttons; the question block and offer; the answer blocks
  (document, phrase, place) on `card` at 18.
- Reactions and rating marks are monotone in the thread.
- The idle, You speak and Working edges follow the prototype: cream at idle, a pool of light by the field when he
  speaks, Life blue only when working (`app-aura-0`, `app-aura-you-speak`, `app-aura-working`).
- Nothing else moves by itself: the only motion seen is the edge, the busy spinners and the aura, all listed or
  covered by findings 5 and 17.

## Second pass (26 Nov)

Worktree head `135af84a5`, rebuilt and shot fresh on the iPhone 18 Pro simulator (iOS 27.2). Screens are
`screens-ds-review/pass2-<page>-<offset>.png`.

**Verdict: passes.** No must-fix left. 7 should, 4 nits.

### First-pass items

| # | Status | Seen in |
|---|---|---|
| 1 Answers truncate | fixed: the recommended one full width, the rest two to a row, nothing cut | `pass2-asks-0` |
| 2 No Mac edge blue | fixed: cream, fainter than idle | `pass2-aura-0-nomac` |
| 3 Notice "Settings" button | fixed: its switch in place, no worded button | `pass2-thread-700` |
| 4 Green switch | fixed: cream track, black knob | `pass2-settings-0`, `pass2-thread-700` |
| 5 Ring reads as a spinner | fixed: a muted still pie before the estimate | `pass2-blocks-0`, `pass2-items-0` |
| 6 Busy looks disabled | fixed: Send stays filled with its spinner, the rest dim | `pass2-asks-0` |
| 7 Ask in a card | partly: on a wash now, but see S1, S2 | `pass2-asks-0` |
| 8 Draft a plain box | partly: chat strip, last message, bubble in the app's colours; see S3, S4 | `pass2-asks-700` |
| 9 Chips left, cream | fixed | `pass2-asks-700` |
| 10 Unfolded item a card | partly: no corners, ask on the item's left line; see S1 | `pass2-items-0` |
| 11 Hairlines, no disc | fixed | `pass2-items-0` |
| 12 Large flag dot | fixed (about 7 pt) | `pass2-items-0` |
| 13 Outdated struck | fixed: faded | `pass2-items-0` |
| 14 Inline reaction | fixed: corner mark | `pass2-thread-0` |
| 15 Rating row bare | fixed: on the card pill | `pass2-thread-0` |
| 16 Deleted line green | fixed: green tick, muted words | `pass2-thread-700` |
| 17 Blue spinner | fixed: text colour | `pass2-blocks-0`, `pass2-thread-700` |
| 18 Held rules | fixed | `pass2-thread-700` |
| 19 Notice shape | fixed: disc, row title, line | `pass2-thread-700` |
| 20 Round button rim | fixed: no rim, about 44 pt | `pass2-blocks-0` |
| 21 Appearance | fixed: gone | `pass2-settings-0` |
| 22 Settings sizes | not changed (still a nit, N1) | `pass2-settings-0` |
| 23 Swatches scroll | fixed: two rows, chosen name under | `pass2-aura-0` |
| 24 System picker | fixed: brand pill | `pass2-aura-0` |
| 25 `on` invisible | fixed: on a cream chip | `pass2-values-0` |
| 26 Colour 👍 in title | fixed | `pass2-thread-0` |
| 27 Prompt, offset | partly: no Focus prompt now; the start offset is still not clamped (S7) | `pass2-items-700`, `pass2-blocks-700` |

### Should

| # | Page | What differs | Fix, in plain words | Screen |
|---|---|---|---|---|
| S1 | asks, items | The wash is a flat rectangle with a hard edge, and stops about 4 pt short of each screen edge, so it reads as a card. Prototype `.inplace`: a radial wash (cream 6% fading to 0) with no edge, bleeding to the screen edges | Draw the wash as the prototype's radial fade, edge to edge | `pass2-asks-0`, `pass2-items-0` |
| S2 | asks | An ask on its own has no header: the prototype's ask (`.pg.ask .hero`) opens with a 48 pt disc, a 19 pt title and its line (project · when) | Give the ask card the item header: disc, title, line | `pass2-asks-0` |
| S3 | asks | The draft strip has no "Open WhatsApp ↗" link, and the unsent draft is a solid bubble. Prototype: the link at the strip's end, the draft as a dashed outline in the app's tint until sent (`proto-draft`) | Add the app's open link; draw an unsent draft dashed, solid only once sent | `pass2-asks-700` |
| S4 | asks | "Not sent" with a clock under a draft that waits for his answer: "not sent" is his bubble's failure word, so a draft he has not answered reads as a failed send | No status under an unanswered draft (the prototype has none); keep "Not sent" for the failure | `pass2-asks-700`, `pass2-asks-1400` |
| S5 | asks | Drafts offer "Not now" and "Later": two ways to put it off. Prototype: Send and Later only; answer 8 says everything that is not an answer is Later | Drop "Not now" from the samples (and from any draft ask) | `pass2-asks-700` |
| S6 | asks | The spending stop sample has no recommended answer, so it shows no filled pill and Later full width. Prototype: "Keep looking" filled, "Later" and "Stop here" under it (`proto-budget`) | Set the sample's recommended answer so the catalog shows the decided state | `pass2-asks-0` |
| S7 | items, blocks | A start offset past the page's end shows a blank screen (`-catalog items 700`, `blocks 700`) | Clamp the start offset to the content's height | `pass2-items-700`, `pass2-blocks-700` |

### Nits

| # | Page | What | Screen |
|---|---|---|---|
| N1 | settings | Row titles 16 pt and value pills 44 pt, against the prototype's 15/600 and 38 pt (first pass 22); hairlines between rows where the prototype groups by section headings | `pass2-settings-0` |
| N2 | items | The unfolded item says its subject twice: "Reply to Sara about Sunday", then "Reply to Sara?"; the prototype's header is the ask's question | `pass2-items-0` |
| N3 | asks | The ask's "why" is in `muted` at line size; the prototype's body is 15 pt cream | `pass2-asks-0` |
| N4 | all | The first launch after an install shows a white screen for several seconds before the dark page | (first shot of `values`, not kept) |
