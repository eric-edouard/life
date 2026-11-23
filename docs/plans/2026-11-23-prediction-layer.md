# Prediction, Life's fourth layer: the owner's direction of 23 Nov 2026

Explanation: the owner's broad idea for a later plan, kept here for the planning session that comes after the agents'
rearchitecture and the chat-first app. Nothing here is designed or built, and nothing here is a decision about how.
Fable plans it when its turn comes, with as few tokens as the first two plans.

## The idea

Life has three layers today: capture (the sources and the pendant), memory (units to pages) and action (the agents,
the cards, the sends). The fourth and last is **prediction**: Life's goal becomes to best predict the owner's next
intent. That is how it becomes a better companion for each person: it removes mental load, it is spot on with its
asks, and it gets out of the way when it is not needed or not wanted.

In his words: "predicting the user is important because it's also how Life becomes a better companion for each user,
removes mental load, is spot on on the asks, and gets out of the way when needed or unsolicited."

## Where it shows first: suggested asks, always on

The suggested asks in the field (rotating in the empty field, sent with the quiet arrow) are always on, not only
while an ask is open. After any big change on screen or any new message from Life, a quick second run reads what is
being shown and proposes the three likeliest next asks. It works in any situation: an open ask (its follow-ups), an
item that just settled (what usually comes next), a list (what to do with it), an empty thread (the day's usual
first asks). The prototype shows it with a stand-in by context
([the shell prototype](https://claude.ai/artifact/7DNThcrd9u89WPWhjfBFCg)). Not over-engineered at first: one cheap
call, on the default model.

## How it learns

Every time Life offers something, it is a prediction, and his choice scores it:

- **A win** when he takes the first thing Life offered: the first option of a decision, Send on the first draft, a
  suggested ask he picks.
- **A miss** when he does something else: another option, an edited draft, his own words instead of a suggestion.
  Life then tries to understand why his choice differed from its offer.
- **The benchmark:** each offer and his choice joins a set of past offers, and what Life knows of him (the prompts'
  inputs, his preferences, its rules about him) changes until it would predict all of them, this latest one included.
  The way Life already proves a change against its regression cases (`AGENTS.md`, "Prove a change cheaply";
  `docs/operations.md`, "Regression cases"), but scored on his own choices.

Much of the record exists already: his answers to cards with the options he was shown (`decisions.jsonl`), what was
sent against the draft he approved, his importance labels and his corrections. What is new is reading them as scores
of Life's predictions, and the suggested asks' offers and picks.

## For the plan to weigh

- What it learns stays his, like the rest of his memory (on his Mac, in his data repo); nothing about him in this
  repo, and the tests on made-up people.
- What "re-run until all pass" costs as the set grows: a sample, the newest misses first, never the whole history at
  once (his rule on proving changes cheaply).
- A miss is not always Life's error: he may simply have changed his mind. How Life tells the two apart, and when it
  asks him (never as a card of its own: the cognitive load rule).
- It also decides when Life says nothing: getting out of the way is a prediction too.
