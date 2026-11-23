# An item's states, wherever it shows

Explanation: the one grid every ask and matter in the chat-first app follows, written on 23 Nov 2026 after the owner
found the same item behaving differently in different places (a sent reply that could be tapped again, a row that
vanished from a list, Later's line landing far from the row he tapped). Each path (opening, answering, notifications,
follow-ups, Undo) follows this grid instead of its own rules. The decisions behind it are in
[`2026-11-23-design-decisions.md`](2026-11-23-design-decisions.md).

## The rules

1. **An item has one state at a time, and every place that shows it shows that state.** A row in a list, a folded
   card in the thread and the open ask are the same item, live: when its state changes, all of them change together.
2. **An item changes state where it is. It never moves or vanishes.** A list keeps its rows; the count says what is
   left. Nothing above the newest item is removed or reordered.
3. **The item says how it stands; Life's lines say only what is not an item's state.** No line repeats an outcome the
   item already shows. Life's lines are for what happens between items: the next card's lead ("Here's the booking
   message for Clinic North"), and an ask skipped ("Left for now, still waiting on you").
4. **A tap is alive only while the item needs the owner or is worth reading.** Settled is history, like a past message
   in a chat.
5. **Answer buttons live only on unfolded items.** A tap unfolds an item where it is, several at once if he likes; each
   copy of one item shows the same choices, live, so nothing can be decided twice. A row offers
   only Later, and only for a task done outside Life (pay, call). An answered item folds back into its row or card.
6. **Undo is on the item, while Life can still try.** Never on a send.

## The grid

| State | Its line (row and card alike) | Tap | Buttons | Undo |
|---|---|---|---|---|
| Needs you | Who it is about · when it is due (coral only for today) | Unfolds it where it is | On the newest open ask only; a row's Later for a task | — |
| Later | Later · tomorrow 9:00 | Unfolds it (he changed his mind) | None | Undo: lifts it back to needs you |
| Under way | Life is on it, in a few words ("Contacting Clinic North"), a small spinner | Nothing to answer; no tap | None | Undo: Life tries to stop it |
| Waiting on someone | What it waits on · when (Waiting on Tomas's quote · Thu) | Unfolds it to read: its line and their last message | None | — |
| Settled | A tick and how it ended (Sent to Nora, Dropped) | None | None | Undo while Life can try, never on a send |

What a tap on Undo shows, on the item's line: "Undoing…", then either "Undone · Reopen" (the item is back to needs
you; Reopen opens it at the bottom), or one line saying why it couldn't ("Can't undo: Life already drafted the
booking") and nothing else.

## Where each path lands

- **Answered on the newest open ask:** the ask folds into its card, its line now under way or settled. No line below.
- **Answered on an item unfolded away from the bottom:** it folds back in its new state, and Life's line at the
  bottom says so, the item's name a link back to it.
- **Later on a row, or on the open ask:** the item's line becomes Later; the count goes down. No line at the bottom.
- **Answered on a notification:** the ask's card (its state line, settled), then his answer as his bubble in the
  card's words with the bell and the time. No line below.
- **Opened from a notification without answering:** the ask at the bottom, needs you, with its buttons.
- **A follow-up:** the answered ask stays under way until the next card is ready; then it settles, and Life's lead
  and the new ask land at the bottom.
- **Skipped (he did something else):** the item folds back, still needs you; an ask Life brought to the bottom is closed
  by Life's one line.
