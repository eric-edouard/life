# Ask cards with no design yet (26 Nov 2026)

What each card shows, in its recommended variant, and what only the owner can decide. Each item is one use case, and its three variants
show that same case in three designs; they are in the design lab, `prototypes/design-lab.html`, where he picks or mixes;
`shell.html` plays his pick, else the recommended one (the lab's Prototype mode). Both draw cards from one file,
`prototypes/card-blocks.js`: a card is data (which blocks, in which order, in which mode).

Sources: `docs/research/2026-11-26-ask-coverage.md` (every kind the server sends), `memory/card-request.ts`,
`memory/needs.ts`, `memory/checks.ts`, `memory/life-checks.ts`, `memory/draft.ts`.

## One anatomy for every ask

Every ask, top to bottom:

1. **Its matter**: the title of the matter it belongs to, one muted line. An ask on no matter (a voice to name, the
   same person, a Contacts card, at organization) puts its subject there instead, the person or the voice.
2. **The goal**, only where it decides the answer (rule C, recommended): a new matter and his own step (your move).
   Everywhere else the title is enough; he can ask for the rest.
3. **The question**: the step, as the card's title (a draft "Reply to Jade", a payment "Pay Paul 240 €"; a new
   matter "Start on this?").
4. **The details**: what he needs in hand (the draft, the amount and account, the event…).
5. **The answers**: one recommended, the rest as pills.

The new matter card is this anatomy with "Start on this?" as its question. Against `docs/product.md`: what, why and
what each answer does stay on the card (rule 6), the goal only where it changes his answer keeps it to what needs him
(the principle), and no agent shows (rule 8). The variants page's first item, "How an ask shows its matter", puts the
same three asks under the three rules: A title only with the goal on a tap, B title and goal always, C title only and
the goal where it decides. Every other item and `shell.html`'s asks use C until he picks. Fix asks (something broken)
keep their own subject in the title and take no header.

Any subject opens its page: a person, a matter. The field follows; Back returns to the thread. The matter page (item "Matter page") holds its title, goal, where it stands, its next step, the asks still open, the people as faces, its thread (`readMatterThread`) and its ending check.

## The seven cards

| Card | What it shows | Answers |
|---|---|---|
| Voice naming, with a guess | Who is this voice?, where it was heard and how much; each clip with a play button and its words; a hint that TV or radio can be named so | Yes, Nora (Life's guess) · Someone else… · Don't name |
| Voice naming, no guess | The same, then the people it may be as rows, someone new last; someone new asks their name in the thread | (the rows) · TV or video · Don't name |
| New matter | Its matter's title and goal, then "Start on this?", its next step, and one line on what Start does ("nothing goes without you") | Start · Edit goal · Not this |
| Is this done? | On its matter's page only, on the step it would close: the later words that seem to close it | Yes, done · Not yet |
| Same person | The two side by side, each with where he sees them | Same person · Different |
| Contacts card | The card's name and number, then the people it may be; a tap on one answers | (the rows) · Someone new |
| At organization | Is Lea at Fernway?, with the role and where it comes from | Yes · No |
| Your move | His step with where and when (place, phone) | Mark as done · Hand it to Life (when Life can) · Later · Drop |

## What a card shows so he can answer without leaving

| Detail | Recommended |
|---|---|
| Amount and account | The amount large, the account as rows, a link to his bank |
| Payment code | The code large enough to scan, the amount, the message it came from |
| Link | A preview: the vendor, the page's title and domain |
| Event | A box: when, where, its reminders as chips |
| Paid search | What it gets, "About $1.20", "Never more than $3" |
| Plan | Each step with who does it (his steps marked You) and when; the source chip under |
| Context | A short paragraph with Life's links in it, then a quote and its source |
| Seen done | Nothing to tap: when the payment shows in his bank, the ask closes itself and Life says so once |
| Voice clip | Play, waveform, the words |

## Answers

| Answer | Recommended |
|---|---|
| Add to calendar | The row's line becomes "In your calendar · Thu 18:00 · Undo" |
| Run it | The row shows a still ring and "about 4 min", then "38 found · cost $1.10" |
| I paid it (looks) | "Looking in your bank…", then found, or "Not in your bank yet · I look again until Fri" |
| How am I doing? | The bar under a settled row: three monotone marks and a cross (as in v4) |
| Changing a draft by a tap | Quick-edit chips under the draft change it in place, with a back arrow (as in v4) |
| Changing a draft by words | The old card folds to an "Earlier draft" row; his words, then a new card below (as in v4) |
| A late reply | His question quoted on top of Life's reply |
| I'm on it | A sentence, then the row with a still ring and its estimate (as in v4) |
| Life's mark on his bubble | On the bubble's corner, monotone (as in v4) |

## Left out on purpose (a builder's view, not his)

- No clip count, conversation list or likeness score on the voice card; two clips and the words are enough.
- No Apify actor name or input, no plan step roles, no importance or urgency badges: none helps him answer.
- No "more details" on any card: the context is the detail, and he can ask.

## Open questions for the owner

Each with the recommendation first.

1. The new matter card's server words say "Start an agent on this?", "Start an agent" and "No agent", which name
   the agent. Show the matter's title as the question and answer "Start" and "Not this".
2. "Your move" also offers Hand over when Life could do the step. Keep it as a pill, "Hand it to Life", only then;
   Mark as done stays the recommended answer (variant B makes Hand over first).
3. "Is this done?": ask on the step (A), rather than show it done with one tap to reopen (C). Closing a step wrongly
   hides something he still owes.
4. A paid search costs dollars (Apify bills in dollars) while his monthly amount is in euros. Show it in his currency,
   "about 1.10 €".
5. When Life can see the payment in his bank, show no "I paid it" at all and close the ask when it appears (seen
   done, C). Keep "I paid it" only where Life cannot see it.
6. A Contacts card's row answers on one tap, with Undo on the row after, and no confirm step.

## The design lab and its inventory (26 Nov 2026)

One artifact, [Life design lab](https://claude.ai/artifact/CWn2a8uSCY22i3CMcpB1Cs) (`prototypes/design-lab.html`),
replaces the card variants page and the answer components and Settings pages: one phone, one item at a time, A, B and
C swiped sideways, his pick saved to the artifact's store. Squarish or wide screens (the open Duo, 669 x 951) put the
phone left and the selectors right; narrow or tall ones (under 600 wide, or an aspect under 0.6) make the screen the
phone. Items are data: `card-variants.js` (the cards), `lab-pages.js` (the design system, answers, Settings and his
eleven answers), and the app v4 prototype's scenarios, read from `shell.html`'s own side panel.

What app v4 (25 Nov, [artifact](https://claude.ai/artifact/CvbKKXFzYTko1SZMNB2GrF), `shell.html` on main) held, and
where it is now. Nothing was deleted from `shell.html`: every control below is still in it. What went missing was the
way to reach them: in the card variants page's Prototype tab, the shell sat in a frame as tall as the screen, so on
his phone its side panel (every scenario below) was out of sight below the phone.

| App v4 side panel group | Its scenarios | In the lab |
|---|---|---|
| Long work, handed off | Ask for long work: a physio this week; 20 minutes later: the result lands; Ask how it's going; It reaches what it may spend | Thread item, and Prototype |
| Redrafting a draft | Life brings a draft to Jade; Type a change; the quick-edit chips | Thread item, and Prototype |
| Reactions | You say thanks; "Remind me to call Mum on Sunday"; You react to Life's line | Thread item, and Prototype |
| How am I doing? | Life asks | Thread item, and Prototype |
| Undo after a send | A WhatsApp reply: Undo after; An iMessage reply: no Undo | Thread item, and Prototype |
| Settings, with no page | "Stop notifying me about newsletters"; "What can I change?"; Life offers a setting; Offline: the phone's own settings | Settings item, and Prototype |
| Asks held while you're busy | You go into a meeting; The meeting ends; Morning, after you slept | Thread item, and Prototype |
| The aura | Show my aura's knobs (colour, then speed, brightness, glow, colour and voice light per state, each in its band); Make it teal; Make it more red; Make it more active; Make idle crazier; Which colours can it be? (the ten-colour palette) | Aura item, and Prototype |
| Ask Life (from v3) | The house, the beads order, the bead shop, Nora and me, the electricity bill, Hugo, the lawyer, which Ben, Text Ben, Jade's Saturday, Tomas | Answers item, and Prototype |
| State | Idle, Listening, Working | Aura item, and Prototype |
| Where you are | At home, by your Mac; Away | Thread item, and Prototype |
| Something goes wrong | Offline, the Mac, WhatsApp signed out, the pendant, the budget at 90% | Thread item, and Prototype |
| Outside Life | Jade writes again; You reply to Ben in WhatsApp | Thread item, and Prototype |
| A notification | Answer it, or tap it to open | A banner over the phone in Prototype |
| Taps in the phone | A face opens a profile; the count opens the asks; an ask's page; the boiler matter; the pendant | Pages items, and Prototype |

The lab also holds the 29 card items (with the new "Focused lists swipe sideways"), the design system, the answer
components with their three answers and JSON, the nine Settings proposals, and his eleven answers of 26 Nov as decided
items. Every face is now a full circle (the parts drew a few at 56 with a 24 radius, and the Settings icons as rounded
squares).
