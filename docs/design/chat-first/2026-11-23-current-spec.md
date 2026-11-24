# Chat-first app: the current spec

Explanation: what the chat-first app does, as decided by the end of 23 Nov 2026, in one place. It replaces reading
the design log ([`2026-11-23-design-decisions.md`](2026-11-23-design-decisions.md)), which keeps how each decision was
reached; where the two differ, this page wins. The plan is
[`docs/plans/2026-11-23-chat-first-app.md`](../../plans/2026-11-23-chat-first-app.md), the product rules
[`docs/product.md`](../../product.md), the brand [`docs/brand.md`](../../brand.md). The clickable
[shell prototype](https://claude.ai/artifact/7DNThcrd9u89WPWhjfBFCg) shows it (private to the owner).

## What decides

- Do everything that can be done without the person; show only what needs them or what they asked for
  (`docs/product.md`).
- The yardstick: what a good human assistant could do with him in an iMessage or WhatsApp thread, Life does in its
  thread, better, since it owns the UI.
- The test for any UI idea, his or ours: does it help him get something done with less to think about? If it serves
  the builder's view (completeness, inspection, "just in case"), it is out, and whoever designs with him says so
  before building it.
- Minimal is the brand: a mark or a number on a button, never a word, wherever a mark can say it; words go to
  VoiceOver. Exception: "Later", a word on a quiet pill.

## The always-on layer

- On every screen: the edge, the field at the bottom, and two round buttons at the top: what waits on you (left, the
  count) and the pendant (right). No tab bar, no drawer, no other screen.
- The edge has three states. Idle and You speak: two soft grey lights turning over a faint ring that never goes dark,
  at rest a crisp ring all round with a fixed, even, faint halo under the moving lights, so they never move over bare black and draw the eye (the owner, 23 Nov 2026), every halo thin and close to its edge; speaking doubles their speed and pools the light by the field. Life is working: the blue swell in
  Life's ai colour (`#9aa8ec`), stronger and faster. Changes glide over about a second. It needs the owner's exception
  written into `docs/brand.md` (borders, motion, colour) before it is built.
- The pendant: the lit cream dot, breathing, while it records; a hollow ring when paused; coral only when it needs
  him. Pausing is one tap, never a turn of the main session.
- What is broken and needs him comes first: the thread opens on Life's line and the one button that fixes it.

## The field

- Typing, or holding to talk. Dictated words arrive a word at a time, their letters inking in from blurred to sharp;
  no cursor, no timer; the voice levels fill the width between Cancel and the microphone, which is filled in `fg`.
- **Suggested asks, always on:** the empty field shows Life's three likeliest next asks, one at a time, every 3
  seconds, inked in like dictation, with a quiet send at its end (an outlined circle, not filled, inking in last, after the words); tapping the field types as usual. They come from a
  quick second run on what is shown, and follow his latest action: an item he just unfolded (its asks), an item he
  just answered (what usually comes next), or else what his last action brought to the bottom. They are the first
  face of the prediction layer ([`docs/plans/2026-11-23-prediction-layer.md`](../../plans/2026-11-23-prediction-layer.md)).

## The thread

- One endless conversation, opening at its bottom, with Show earlier and day separators. It grows only with what he
  and Life say.
- His messages: a quiet tinted bubble (cream at 11%, cream text). The count's tap plays his bubble "What's waiting on
  me?" and code's answer, at once.
- What Life says comes in progressively: text word by word, blocks one after another, each from blurred to sharp. It
  is laid out before it shows, so the thread follows in batches: one smooth move when the revealed part reaches the
  bottom edge, leaving about half the view for what comes next, never taking the message's top under the top edge.
  His own words appear at once; under Reduce Motion everything appears whole.
- A page-sized answer of Life's (a matter, a person, a list longer than the screen) shows whole while it is the
  latest, and collapses into its card when he next writes.
- A real document (an attached PDF, a long mail) opens in the system's own viewer; nothing of Life's opens a screen but a picture or a phrase to show someone, full screen ("Answers to his questions").

## Items

An item is an ask or a matter, shown as a row in a list, a folded card, or unfolded. Copies are fine (two lists may
show the same ask): they are one item, live, so a choice made in one shows in all.

### Its states, wherever it shows

The grid grows with what really happens (owner, 23 Nov 2026: chat apps are complex for good reasons); what it never
does is allow a state outside it. A new state gets its row here (its line, its tap, its Undo), and holds in every place
the item shows.

| State | Its line (row and card alike) | Tap | Undo |
|---|---|---|---|
| Needs you | What it is about · when it is due (coral only for today) | Unfolds it | — |
| Later | Later · tomorrow 9:00 | Unfolds it (he changed his mind) | Lifts it |
| Under way | What Life is doing ("Contacting Clinic North"), a small spinner | None | Life tries to stop it |
| Waiting on someone | What it waits on · when ("Waiting on Tomas's quote · Thu") | Unfolds it to read | — |
| Settled | A tick and how it ended ("Sent to Nora", "Dropped") | None: it is history | While Life can still try; never a send |
| Queued | A small clock · Goes when you're back (answered while offline) | None | — |
| Outdated | The whole row faded to the back, its line the reason ("Nora wrote since", "You replied in WhatsApp") | None | — |

- An item changes state where it is. It never moves or vanishes: a list keeps its rows, the count says what is left.
- The item says how it stands, so no line repeats it. Life's lines are only for what happens between items: a
  follow-up card's lead, a skipped ask, a decision made away from the bottom.

### Unfolding

- No cards (owner, 23 Nov 2026): rows are bare (face, ask, line, no background). An unfolded item looks the same
  wherever it is (in a list, or an ask Life brings to the bottom): it takes room above and below, its header grows (a
  larger face and title), and a very faint wash of light sits behind it, with no edge. Folded, it is a bare row again.
- A tap unfolds an item where it is, several at once if he likes; each folds by its ⌃ or when answered. Typing,
  speaking or Life's next message leave them open.
- Answer buttons live only on unfolded items (and on an ask Life brings to the bottom). A row of a list offers only
  Later, and only for a task done outside Life (pay, call), and only on the newest list.
- Its motion is not the ink: its height is measured first; the thread scrolls just enough for the whole item to fit,
  never taking its header under the top edge; then it opens in one vertical reveal of about 0.4 s. Folding reverses it.
- Answered away from the bottom of the thread, it folds back in its new state and Life's line at the bottom says so:
  "You answered **Pay Tomas 240 €**", the name a link that scrolls back to it and lights it once.

### One shape for every ask

- Who asks, in large (their face or mark, the one-line ask as title, the row's line "what · when"), at most one line
  of why, then the body of its kind, then the answers. The row and the unfolded ask show the same header.
- The answers: the recommended one full width (the only cream fill on screen), saying what it does ("Send to Nora",
  "I paid it", "Contact Clinic North"); under it the others as equal quiet pills: Later (or the card's own "Not now"),
  an alternative, Drop it.
- Bodies by kind: a fix, why in a line and the numbered steps; a reply, its chat with the draft; a choice, options as cards (radio, name, Life's pick preselected,
  one line of facts, a "Google Maps ↗" chip for a place); a payment, the amount large, to whom, the IBAN in mono, the
  reference, "Open your bank"; a calendar add, when, where, reminder; a call, the number to tap and what to say;
  waiting on someone, one line and their last message, no answers.
- A draft is branded per app: the app's logo, the chat's name and size ("Halden house · 5"), "Open WhatsApp ↗" in
  the app's colour; at most the last 5 cited messages plus the one replied to, unrelated ones as a count; the draft on
  the app's colour with a dashed outline that fades once sent.
- No "more details" button and no full view of everything: the rest stays behind the field, for him to ask.

### Answering

- Every answer reads the same way: the button turns to doing ("Sending…", waiting for the real outcome), then done
  (a tick, "Sent", green) for one second; then the item takes its new state.
- A failure shows on the button itself: "Not sent", tap to try again; or "May have gone", no retry.
- Undo is an attempt, never a promise: "Undoing…", then "Undone · Reopen" (Reopen brings the ask back), or one line
  saying why it couldn't. A send never has Undo. What each undo needs is in the plan.
- An ask goes out of date when someone wrote in its chat since (its agent writes a new draft, a follow-up card), when he
  answered there himself (he often will, outside Life), or when its agent withdrew or replaced it; unfolded, it folds.
- Under way never spins for ever: Life first tries to fix a stalled task unseen; if it can't, the item comes back to
  needs you with one line of why ("Couldn't reach Clinic North"). The limit: a few minutes for a draft, a long task's
  own deadline for the rest.
- Answered at the same moment elsewhere (the Watch, a notification, another copy): the later tap does nothing and its
  button reads "Already answered: Sent".
- An ask Life brought to the bottom that he skips (he types, speaks, opens something else) loses its buttons, and one
  quiet line closes it: "Left for now, still waiting on you".

## Profiles

- A face is a person's or organization's; a tap opens their profile over the thread (owner, 23 and 24 Nov 2026): the
  face rises and grows to the top, the thread blurs and darkens behind, and their page eases in under it, in plain
  titled sections: who they are to him, the ways to reach them (round app buttons, no words), what needs him, where
  things stand, what waits on them, what is coming up, the last time, what they are like (in Life's blue). A glass
  back button, or a drag in any direction, lets it go: it follows the finger, shrinks, and the face flies back to its
  place.
- A profile is one level deep, never a stack: tapping an item on it (an ask, a matter, something that waits on them)
  closes the profile first, the face flying back, then asks it in the thread: his bubble in his own words ("What do I
  owe Tomas for the old company?"), then Life's answer as usual, ending on its question when it has one. An ask comes
  as Life brings it to the bottom, with its answers.

## Arrivals

- **A follow-up card** (the next card of one he just answered): the answered item is under way meanwhile; the card
  lands at the bottom with Life's lead, at once if he is free, else once he stops typing, speaking or reading Life's
  answer. If he has scrolled up, nothing jumps: a small down pill shows.
- **In the app**, no banner. An unrelated ask follows its notification level (proposed): quiet, only the count;
  normal or urgent, it lands once he is free. Whether Life should notify fewer asks at all is the plan's.
- **A notification** is the ask: its one-line ask as title, who and when, the draft, at most two answers (the main one
  and Later, in the card's words). Silence when it worked; only a failure notifies. Answered there, the ask lands in
  the thread as its card in its state, then his answer as his bubble in the card's words with the bell and the time.
  Opened without answering, Life brings the ask to the bottom with its answers.

## When Life can't be reached

- Offline, everything still works and is queued: his words (his bubble with a small clock), his answers and his
  sends. Back online, each goes only if nothing changed meanwhile; an answer to an ask that went out of date is
  dropped and said so. Nothing is greyed.
- The edge goes still while Life can't be reached.
- A failure that needs him is an ask, of the kind "fix" (owner, 23 Nov 2026): its face is what broke (the WhatsApp
  mark, the pendant, €), its title the one-line fix ("Sign WhatsApp back in"), its line what it costs and since when
  ("Can't send on WhatsApp · since 11:02"), its body the steps, spoon-fed for where he is, its answers the fix and
  Later in his situation's words. It ranks first in what waits ("what is broken comes first") and has every state of
  an ask. The caretaker writes it from what Life knows: at home by the Mac, the steps; away, its main answer is
  "Remind me when I'm home", which wakes it on his arrival. It offers only a step Life can really do.
- What he can do nothing about right now is not an ask but a notice: an ask's header and nothing else (owner, 23 Nov
  2026), so the thread has one shape for anything Life puts in front of him. Its mark in the face (no signal, the Mac),
  what is wrong as the title ("You're offline", "Your Mac isn't answering"), what it means for him and since when as
  the line ("What you do waits · since 15:40", "Nothing is lost · since 14:10"). No body, no answers, no tap, not in
  the count. One per problem, updated where it is; fixed, it settles like an item: a tick and how it ended ("Back
  online · 2 sent", "Back · caught up").
- Life failing to answer: "I couldn't answer that." Tapping his bubble asks again. Never "tell the caretaker": it is
  told without him.

## Not doing, and why

- A full screen for an ask, the zoom, a "more details" view: an assistant never sends him to another screen.
- Each tap becoming his bubble with a copy of the item at the bottom: it felt like a chat bot. (Kept only behind the
  ask Life brings itself, and the notification answer, which happened outside the thread.)
- Reopen buttons on settled items; an outcome said twice.
- From AI chat apps: many conversations, a sidebar, regenerate, edit a message, copy, a model picker, a trace of
  the work.

## Answers to his questions

Tried on his real Life on 23 Nov 2026 (the house, a sister's bead order, what to say at the shop).

- Life's words are full Markdown, as he knows it from AI chat apps: headings, lists, bold, quotes, code, tables,
  images, `life:` names that unfold. He will ask about people, patterns, his past, not only lookups.
- Under the words, only what the answer is about, never a data model's page: the things that wait as item rows in
  their states, pictures, a table, a phrase to say, a place.
- A picture, or a phrase to show someone, opens full screen on a tap (owner, 23 Nov 2026: worth it, the one
  exception to "nothing opens a screen", since holding the phone up is the task).
- "Show me" a matter or an ask: Life says where it stands in a sentence, then its item in its state, which unfolds by
  itself once in place, since seeing it is what he asked (24 Nov 2026). No page of its own.
- How those shapes are made (fixed blocks, components the agent composes, or generated HTML) is the plan's to decide (the plan, "Life's own catalog of blocks").

### While Life works

One line under his words says what Life is doing now, until its answer starts (owner, 24 Nov 2026):

- A step is a verb and what it acts on: "Reading your chat with Nora", "Opening the kitchen", "Searching the web for
  “opening hours”". The verb is quiet, the object bright; a person shows with their face. Never a tool's name, an
  agent's or a ref.
- Each new step takes the last one's place: the old line blurs away upward while the new one inks in letter by
  letter, the entrance of dictated words. One line, never a list of steps.
- A step that reads or acts turns a spinner. Thinking turns a mark of its own (three dots circling, breathing) and
  says "Thinking…", the word shimmering. A retry says "Taking a little longer…".
- When his answer starts, the line blurs away and the words ink in where it was.

### Life's questions

- Life answers as it wants, then ends with its question when it needs one (owner, 23 Nov 2026). A question is not an
  item: it is not counted and never notifies; its suggested answers become his words.
- Each kind of question gets its own control (owner, 23 Nov 2026: design E of the
  [questions page](https://claude.ai/artifact/1KczjS4siwxnjYkEJ5RHLU); drawn on the Answers page of the Chat design
  canvas): which one or an offer, two equal pills under the question, the likelier inverted (cream, black text) and on
  the right, as on an ask (owner, 24 Nov 2026); a yes before an act, the same, the act's answer inverted on the right; an option with consequences, option cards with one line of facts and Life's pick
  in Life's blue; a value, a row of equal round pills with a gap between them, never a merged segmented control; a person, their faces side by side; his own words, the field starts his
  sentence with Life's suggestion and the microphone calls softly. Typing or speaking always answers too; doing
  something else leaves the question, with no closing line.
- An answer can start real work and move a matter (owner, 23 Nov 2026: "a question could lead to real agent work").
  Such an answer carries a small lit mark; once tapped, the work shows under his bubble as an item in its state
  (under way, with Undo while Life can still stop it), and settles or hands on to what comes next. Work that would
  send anything in his name becomes an ask with its draft instead: the yes is on the exact words, never on the
  question's answer.

## Open

- How the answer shapes are made (the plan decides).
- The icons of the two round buttons; what Later offers; haptics; the edge's brand exception.
