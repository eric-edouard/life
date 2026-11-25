# App v4 prototype: what it adds, where it drifts, what to decide

Reference: the nine pieces the app v4 prototype adds, the drifts between the prototype, the decided docs and the brand,
and the decisions the owner takes before the phone bundles (P2, P3) build from it. The prototype is
[`prototypes/shell.html`](prototypes/shell.html), published as the owner's private artifact
[app v4](https://claude.ai/artifact/CvbKKXFzYTko1SZMNB2GrF). The current spec
([`2026-11-23-current-spec.md`](2026-11-23-current-spec.md)) and the v4 plan
([`../../plans/2026-11-25-overhaul/README.md`](../../plans/2026-11-25-overhaul/README.md)) still win where this page
only proposes.

## The nine pieces, as drawn

| Piece | How it shows | Choices for the owner |
|---|---|---|
| Long work, handed off | 👀 on his bubble, one line of Life's ("I'm on it…"), then the item under way: a still ring that fills at each milestone, and the estimate ("About 20 min", then "About 10 min left"). The edge goes back to idle: background work never keeps it blue. The result lands later as a follow-up whose lead links back to the item; 👀 turns 👍. "How's it going?" is answered in words with the item. | A still ring instead of a spinner for 20 minutes; the edge not showing background work; Undo on under way reads "Undoing…" and stops it. |
| Redrafting | Typed: his bubble, the old version folds to a faded row ("Earlier draft") above it, the same ask lands again below. Tapped: up to three chips under the draft (Warmer, Shorter, In French); the draft blurs and inks in place; a back arrow returns to the last version. | Chips carry words (the plan's `edits`); the back arrow. |
| Reactions | Life puts 👀 (handed on) or 👍 (done) on his bubble, alone or with words ("Sunday at 10:00."). He holds or double-taps a line of Life's for 👎 👍 🤩, the same three marks as the rating. Emoji are drawn in monotone. An ask's answers stay: a reaction is never his OK. | Monotone emoji; the same three marks for reactions and rating. |
| How am I doing? | One quiet row under an answered ask: the question, 👎 👍 🤩 and a cross. A tap keeps the mark, says "Thanks" and fades. Nothing follows. | No follow-up question after 👎. |
| Undo after a send | WhatsApp: the sent row reads "Sent to Lena · Undo until Fri". Undo opens what the other side will see ("…will see “This message was deleted”, and may already have read it") and two answers; then "Undoing…", "Deleted for both of you". iMessage and mail show no Undo. | A confirm step before deleting. |
| Settings, no page | A settings block in Life's answer: switches and value pills act in place, a green tick for a second. "What can I change?" shows sending (Face ID before Send), spending, the aura's colour and appearance. An instruction he gives ("don't notify me about newsletters") shows as its switch. Life offers a change as a question with two pills. The offline notice carries Face ID and appearance; the Mac notice adds pairing again. | Whether recorded instructions show as switches (below). |
| Held asks | Asks that arrive in a meeting, a Focus or Sleep wait: no push, no count. One with a deadline comes through. Afterwards they arrive as rows under one quiet separator ("While you were in your meeting · 14:00 to 15:00", "While Sleep was on"). | The separator. |
| Spending stop | The item under way comes back to needs you: "Keep looking for a physio?", why in one line, then one small line "About 1 € more · 1 € so far", answers Keep looking, Later, Stop here. | Amounts in a line, never in the title. |
| The aura | See its own section below. | The palette; the bands. |

## The aura

The aura is the edge's animation, Life's presence. It has one colour at a time. Each state mixes cream toward that
colour by its own colour knob, so the default (Life blue) keeps today's look: cream at idle and when he speaks, blue
when Life works.

He changes it by asking ("make it teal", "make it more red", "make it more active", "make idle crazier"); the knobs
show as a settings block ("Show me my aura's knobs"): the colour, then a state picker (Idle, You speak, Working) and the
knobs of that state. Each knob's band is drawn on its whole scale, its ends labelled, and the edge previews the state
while he drags.

### Knobs and bands

| Knob | Drives | Idle | You speak | Working |
|---|---|---|---|---|
| Speed | the turning lights' speed | 0.4–1.2× | 1.5–2.8× | 0.8–2× (the swell) |
| Brightness | the ring and lights; the swell when working | 10–35% | 40–60% | 65–100% |
| Glow | the halo's blur | 6–13 pt | 12–20 pt | 16–28 pt |
| Colour | how far cream moves toward the aura's colour | 0–30%, never above You speak | 0–50% | 70–100% |
| Voice light | the pool of light by the field | none | 50–100% | none |

The bands never cross where they set the states apart: idle's speed, brightness and colour always stay below the
other states'. A request past a band is held at its end, and Life says so in one line ("Idle is at its liveliest
now. That's its limit, so it never looks like I'm working.").

### Palette

Ten colours, in hue order. "Make it more red" moves one step toward red; past the end Life says it is as far as it
goes. Red and bright green are left out: they mean "needs you" (`flag`) and "it worked" (`ok`). Asked for red, Life
picks rose and says why. Each colour was checked against `tokens.css`: its dark value on `bg` dark (#000000), its
light value on `bg` light (#f3f4f5), both above 3:1, the WCAG minimum for graphics.

| Name | Dark | On #000 | Light | On #f3f4f5 | Hue |
|---|---|---|---|---|---|
| Rose | #ee8fb1 | 9.2 | #a3345e | 5.9 | 339° |
| Amber | #f2ad5b | 10.9 | #8f5510 | 5.5 | 33° |
| Sand | #e3c48f | 12.6 | #7a5a24 | 5.8 | 38° |
| Sage | #a7cf96 | 12.0 | #3f6b35 | 5.7 | 102° |
| Teal | #6cd0c4 | 11.5 | #126e66 | 5.5 | 173° |
| Sky | #86c5f0 | 11.3 | #1f5f8b | 6.2 | 204° |
| Life blue (default, `ai`) | #9aa8ec | 9.2 | #33468f | 7.9 | 230° |
| Orchid | #c59bf0 | 9.3 | #6a3ba6 | 6.8 | 270° |
| Silver | #c4c7cf | 12.4 | #555963 | 6.4 | neutral |
| Cream (no colour, `fg`) | #fff8ea | 19.9 | #0d0e11 | 17.5 | neutral |

Rose (34° from `flag`) and Amber (20°) sit nearest the coral of "needs you". They differ in lightness and never fill
a control, but the owner should look at them on his phone.

## Drifts

### Against the brand (`docs/brand.md`, `assets/brand/tokens.css`)

- Colours: the prototype hard-codes about 40 greys instead of the 13 tokens, and has no light mode (the app follows
  the system's appearance). Extra greys: discs (#24252b, #2a2b31, #2b2c33), bubbles (#17181c, #1c1d22), a brighter
  second muted (#b9b4aa) for the why line, the call script and Later. Fixed here: the success green now uses `ok`
  (#30d158, was #6fc98a).
- No borders: the row flash drew a 1.5 px ring; fixed here to a brief wash of light. Still drawn: a 0.5 px inner
  hairline on glass controls and profile buttons, and the radio and step circles as rings.
- Shapes: 23 radii against "controls 12, panels 22, buttons full pills". Option cards, boxes and settings use 16–22.
- Type: 22 font sizes and weights 450–800 against Manrope at 15 px body, 650 for what he reads or answers, 13 px 600
  for headings.
- Motion: "nothing moves by itself" has owner-approved exceptions not yet written in brand.md: the edge, the pendant
  breathing, the ink-in reveal, the suggested asks turning every 3 s, the thinking shimmer, the under way spinner.
- Colour only for meaning: the app's own colours on drafts (WhatsApp green, Messages blue), map marks, the hue of a
  profile's face, and now the aura's palette.
- Wording: brand.md says the interface never says "I"; the spec (and the owner's own "How am I doing?") have Life
  speak as "I". Button words go beyond "Later": answers, chips, value pills, the Undo confirm.

### Against the spec and the v4 plan

Fixed in this prototype after the audit: held asks no longer raise the count; "How am I doing?" sits under an answered
ask with no follow-up; 👀 is only for handed work; the spending stop uses the plan's 2% of the monthly amount; "Hold
asks while you're busy", "Notify me for" and "Later means" are no longer switches (Later is offered as a question);
the offline notice no longer offers pairing; one Undo vocabulary ("Undoing…", then the outcome).

Still open in the docs:

- The spec says "A send never has Undo" (current spec, Answering); the plan reverses it (question 20). The spec is
  not updated.
- The spec's state table lacks Held (not shown), Earlier draft (a kind of Outdated), Deleted for both (a Settled
  outcome) and Stopped. It says each new state gets its row there.
- What happens when an estimate passes: the spec's limit is the task's own deadline; nothing names the line.
- A notice has no body (spec); the plan gives one only to "Your Mac isn't answering"; the owner's brief puts device
  settings on the offline notice too.
- The spec's "Not doing" list bans regenerate and editing a message; quick edits come close and need a line there.
- The plan keeps one Mac setting (the monthly amount) and turns "quiet" or "later" into recorded instructions; the
  owner's brief wants switches that act in place. The prototype shows a recorded instruction as its switch.
- The glossary lacks: thread item, under way, held, notice, fix ask, reaction, rated, edits, spending stop, aura; and
  "ask" and "settled" already mean other things there.

## Decisions for the owner

Each with the recommendation first.

1. Tokens: the phone takes `tokens.css` only, plus three new tokens written into it: `tint` (cream at 8–14%, quiet
   pills and his bubble), `glass` (floating controls) and `wash` (an unfolded item). Every other grey goes.
2. One type scale: 26 (a profile's name), 19 (an unfolded header), 16 (a row title), 15 (body), 13.5 (a row's line),
   13 (a section heading), 11.5 (meta). Weights 450, 600, 650.
3. Radii: full pill for buttons, 12 for small controls, 18 for a block in the thread (option card, box, settings
   block), 22 for a sheet. Amend brand.md's "Shape" to say so.
4. Write the motion exceptions into brand.md, with the aura as their home: the edge, the pendant, the ink-in, the
   suggested asks, the thinking line; plus "a long task shows a still ring, never a spinner".
5. Write the colour exceptions into brand.md: an app's own colours on its drafts, faces' hues, the aura palette
   (never red or bright green).
6. Emoji in Life's interface are monotone; the owner reacts with the rating's three marks.
7. "I": Life may say "I" in its sentences; a button never does. Amend brand.md's Wording.
8. Button words: an ask's answers, a question's answers and a confirm's two choices may carry words; chips come from
   the card's `edits`. Everything else is a mark, or Later.
9. Recorded instructions: show the one he just gave as its switch, so a tap undoes it; "What can I change?" lists
   only real settings.
10. Update the spec in one pass: Undo on a send, the four new states, the notice body, quick edits, held asks, the
    aura; then the glossary.
11. Light mode: draw the light version before P2 builds, or say it waits (the plan leaves it out of the first app).

## For the phone bundles

- Build from tokens, never from the prototype's literal colours; the prototype's CSS is a sketch.
- The aura is one component with a state, a colour index and per-state knob values; its bands live in one table in
  code, and Life's main session changes it only through the same setting the block writes, clamped by that table.
- A reaction is a mark on a message, never `said`, never an answer.
- Every new item state (Held, Earlier draft, Deleted for both, Stopped) is a row of the spec's table before it is
  built.

## The owner's answers (26 Nov 2026)

All eleven as recommended, taken one by one: 1 the 13 tokens plus `tint`, `glass`, `wash`; 2 the type scale of seven
sizes, weights 450, 600, 650; 3 four radii (pill, 12, 18, 22); 4 the motion exceptions listed, a still ring for long
work; 5 the three colour exceptions; 6 monotone emoji in Life's interface; 7 "I" in Life's sentences, never on a
button; 8 words only on an ask's and a question's answers, a confirm's two choices and a draft's quick-edit chips;
9 an instruction he just gave shows as its switch, "What can I change?" lists only settings; 10 the spec and glossary
updated in one pass; 11 dark only for now.
