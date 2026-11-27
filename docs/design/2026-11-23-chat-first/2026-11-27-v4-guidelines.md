# App v4: the guidelines

Reference: the rules a builder or an agent follows when drawing anything Life shows on the phone, one line each, with
its source. The first part holds only what the owner approved; open proposals are listed apart at the end and are not
rules until the owner says yes. Where a source and this page differ, the source wins: fix this page. The approved prototype is
[`2026-11-25-app-v4.html`](2026-11-25-app-v4.html) (published as "app v4").

Sources: [product](../../product.md), [brand](../../brand.md), [spec](2026-11-23-current-spec.md),
[design system](2026-11-25-app-v4-design-system.md) (the owner's 11 answers of 26 Nov),
[components](2026-11-26-original-components.md) (the owner's rules of 26 Nov).

## What decides

- Do everything that can be done without the owner; show only what needs the owner or what the owner asked for. [product](../../product.md#the-principle)
- The bar is a 70-year-old who doesn't know an iPhone; the yardstick, a good assistant in an iMessage thread. [product](../../product.md#the-principle)
- Judge every idea from the owner's seat: does it get something done with less to think about? Say so before building one that serves the builder. [spec](2026-11-23-current-spec.md#what-decides)
- At a glance, with no context, a row or card answers "what is this about?" and "what is asked of me?". [components](2026-11-26-original-components.md#start-from-his-seat-his-word-26-nov)
- Where the approved prototype already draws something, it wins: no variants of it. [components](2026-11-26-original-components.md#start-from-his-seat-his-word-26-nov)
- Hiding what mattered costs more than showing something useless; silence must mean "all handled". [product](../../product.md#the-rules)
- Life's insides never show: no agents, roles, steps, models or prompts. [product](../../product.md#the-rules)
- An empty screen is a valid screen; never fill it, never say all is well. [product](../../product.md#the-rules)

## The screen

- Always there: the edge, the field at the bottom, the count (left) and the pendant (right). No tab bar, drawer or other screen. [spec](2026-11-23-current-spec.md#the-always-on-layer)
- What is broken and needs the owner comes first, never capped. [product](../../product.md#the-rules)
- Opening (launch, or back after 5 minutes): "Hi" and the owner's first name, what is broken, at most 3 blocking asks, a pill for the rest. [product](../../product.md#the-rules)
- Nothing opens another screen but a profile (over the thread, one level deep), a picture or a phrase to show, and the system's own viewer. [spec](2026-11-23-current-spec.md#profiles)
- Dark only, for now. [design system](2026-11-25-app-v4-design-system.md#the-owners-answers-26-nov-2026)

## Items: rows and asks

- Rows are bare: face or mark, a one-line title, the line "what · when". No card behind a row, no box around a list. [spec](2026-11-23-current-spec.md#unfolding)
- Several items come as rows; a single item in an answer arrives unfolded. [spec](2026-11-23-current-spec.md#answers-to-his-questions)
- An item's title is what the owner must do, verb first, short. [components](2026-11-26-original-components.md#wording)
- An ask does not show its matter, for now. [components](2026-11-26-original-components.md#start-from-his-seat-his-word-26-nov)
- An item changes state where it is; it never moves or vanishes. Its states are the spec's table, and a new state gets its row there first. [spec](2026-11-23-current-spec.md#its-states-wherever-it-shows)
- A tap unfolds an item in place; answer buttons live only on unfolded items. A row offers only Later, for a task done outside Life. [spec](2026-11-23-current-spec.md#unfolding)
- One shape for every ask: who asks, the title, the line, at most one line of why, the body of its kind, the answers. [spec](2026-11-23-current-spec.md#one-shape-for-every-ask)
- The recommended answer is the only cream fill, full width; the others are quiet pills. A question's two pills are equal, the likelier cream and on the right. [spec](2026-11-23-current-spec.md#one-shape-for-every-ask)
- No "more details" button, no full view of everything: the rest is behind the field. [spec](2026-11-23-current-spec.md#one-shape-for-every-ask)
- A quoted message looks like its app: its mark, its colour, "Open WhatsApp". [components](2026-11-26-original-components.md#start-from-his-seat-his-word-26-nov)
- Voice is read, not drawn: the words dim, each turning cream as it plays; no waveform, no duration. [components](2026-11-26-original-components.md#start-from-his-seat-his-word-26-nov)

## Answering

- Every tap shows its result: doing, then done in green for a second, then the new state; a failure shows on the button. [spec](2026-11-23-current-spec.md#answering)
- Undo is an attempt: "Undoing…", then the outcome. A send has Undo only while Life holds it. [spec](2026-11-23-current-spec.md#answering)
- Nothing traps the owner in a step: every question can be left, and typed or spoken words always answer. [components](2026-11-26-original-components.md#13-every-question-can-be-left-and-his-own-words-always-answer)
- Life speaks with "I" in its sentences; a button never does. [brand](../../brand.md#wording)

## Words

- Every fact once on a card: no name, title, line or icon said twice. [components](2026-11-26-original-components.md#start-from-his-seat-his-word-26-nov)
- No number the owner can't act on: no counts, durations, confidence or "1 of N". [brand](../../brand.md#wording)
- A mark or a number on a control, never a word, wherever a mark can say it; "Later" is the one quiet word. [brand](../../brand.md#the-values)
- Words only on an ask's and a question's answers, a confirm's two choices and a draft's quick-edit chips; three words at most. [brand](../../brand.md#wording)
- The question is the first line and ends with "?"; no category title, no prose title above content. [brand](../../brand.md#wording)
- None of the system's words: fact, guess, handle, step, turn, desk, card, agent. [brand](../../brand.md#wording)

## The look

- Colours only from `tokens.css`: the 13 tokens plus `tint`, `glass`, `wash`; never a literal. [brand](../../brand.md#the-values)
- Manrope, seven sizes (26, 19, 16, 15, 13.5, 13, 11.5), weights 450, 600, 650; no capitals. [brand](../../brand.md#the-values)
- Four radii: pill, 12, 18 (a block in the thread), 22 (a sheet). Spacing 8, 16, 24, 48. [brand](../../brand.md#the-values)
- No borders, outlines or rings; the one exception is a draft's dashed outline. [brand](../../brand.md#the-values)
- Colour means something: `flag` needs the owner, `ai` Life's guess, `ok` it worked. Exceptions: an app's own colours, faces' hues, the aura. [brand](../../brand.md#the-values)
- Emoji are monotone; reactions are 👎 👍 🤩, plus 👀 for handed-on work. [brand](../../brand.md#the-values)

## Motion

- Nothing jumps: every state change, new element and shift of layout animates; what sits below slides. [brand](../../brand.md#motion)
- By itself only the edge, the pendant, the ink-in, the suggested asks and the thinking shimmer move; a long task is a still ring, never a spinner. [brand](../../brand.md#the-values)
- Unfolding measures first, scrolls just enough, then opens in one 0.4 s reveal; answers never sit under the field. [spec](2026-11-23-current-spec.md#unfolding)

## How a design is done

- A new or changed card is first scored, as a screenshot only, by a reviewer with no context. [components](2026-11-26-original-components.md#start-from-his-seat-his-word-26-nov)
- Accessibility follows the design: clipped text is a bug, and so is an issue the prototype's state doesn't have; contrast and text size the prototype shares are shown, never blocking. His words: "accessibility, like contrast and text size, we don't care about much if it's already what the design has provided for… we just want to follow the design. Cut-off text, yes it's an issue. I just want things to be fast." (27 Nov 2026) [plan](../../plans/2026-11-26-app-matches-prototype.md#the-board)
- Done means ran live: on the owner's real Life, then a screenshot compared element by element with the prototype. [AGENTS.md](../../../AGENTS.md#workflow)

## Open proposals (not rules until the owner's yes)

- Ask titles: written to one line, 30 characters at most; the row allows two lines, clamped. [design system](2026-11-25-app-v4-design-system.md#ask-rows-titles-and-the-leading-mark-proposal-26-nov-2026)
- Two-line rows: 10 px above and below, the mark on the first line, Later centred; drop "Your move". [design system](2026-11-25-app-v4-design-system.md#ask-rows-titles-and-the-leading-mark-proposal-26-nov-2026)
- A row leads with who it is with, else the matter's icon, else a mark by kind; never a tick. [design system](2026-11-25-app-v4-design-system.md#ask-rows-titles-and-the-leading-mark-proposal-26-nov-2026)
- Voices to name: one row in "N more", one voice at a time, at most one suggestion first, names typed in the Ask Life field. [design system](2026-11-25-app-v4-design-system.md#voices-to-name-proposal-26-nov-2026)
- Lists are rows, not tiles: a list of matters or asks is always rows. Tiles are never used for matters. They are allowed only for a run of at most 5 asks of one kind, each answered with one tap. Code decides this, not the agent per answer, and there is no setting. A list in an answer shows its first 8 rows, then "N more". [design system](2026-11-25-app-v4-design-system.md#a-list-of-matters-rows-or-tiles-proposal-27-nov-2026), [screens](2026-11-27-screens-list-vs-tiles/)
- v5 idea, turn by turn: adopt parts. First slice: each ask starts a fresh screen, Life working in the centre under a mesh while the edge dims. [v5 proposal](2026-11-27-v5-turns-proposal.md)
