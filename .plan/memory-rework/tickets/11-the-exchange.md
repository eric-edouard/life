---
type: grilling
blocked_by: [04, 24]
---

# The exchange

## Question

What one exchange is, the unit the focused reads code: where it starts and ends (silences, a day, a call), mention passages (talk about someone, with the listener), group chats with the other side's lines as context, recordings. And how it relates to units and episodes, so there is one source of truth.

Also (his ask, 9 Nov): the passages where he or the other person talks about someone absent, in a call or a chat, are part of what an exchange read covers; how an unnamed third party ("elle", "lui") is resolved to a person, from the whole conversation and what Life knows, and how a guess is marked.

## Decided so far (grilling of 10 Nov)

- An exchange is cut by code, never by a model: one sitting of talk between him and someone (a call, a recorded
  conversation, a run of messages until a long silence). Same cut at any age of the data.
- It is not stored twice: a slice over units' messages; an episode points at the exchanges inside it.
- Every two-sided exchange gets the close read, with anyone, at any age (his answer). Closeness is a result, never the
  filter. Skipped by code: notifications, newsletters, messages nobody answered, big groups where he never speaks.

- Units keep their shape and their day cut (his yes, 10 Nov): a message's day never moves, so a late-synced message
  can't orphan what cites a unit; a sitting's edges can move. So nothing stores an exchange id: coded acts cite
  messages (refs and a checked quote, as observations do) and are grouped into exchanges when read; a read is cached
  by the exchange's text.
- New beside the units, by code and free at any age (his yes, 10 Nov): measured facts per exchange (who started, reply
  delays, each side's share of words, who had the last word, left unanswered, time of day, call length and who called,
  speaking time, how many people, language, place). Meters about initiative, responsiveness and balance count these
  directly; a stronger model never has to re-read them.
- The sources' signals Life drops today are read, by code, where a source holds them (his yes, 10 Nov): reactions (an
  answer without words, so "left unanswered" is right) and which message a reply answers (in a group: who talks to
  whom). Today reactions are filtered out and reply links never read (`sources/bridged.ts`).

## Decided by the designer (10 Nov; he left the shape to the designer and can overrule)

- **Where a chat's or a mail thread's exchange ends**: a long silence, several hours, so replies within one waking day
  stay together and a night ends it; the number is set from his own message gaps at the pilot. A next-day answer opens
  a new exchange, marked by code as an answer and read with the last lines before it as context.
- **One channel per exchange** (a chat, a mail thread, a recording); the episode joins across channels. A recording's
  exchange is lifelog's conversation, with lifelog's edges; only assigned and matched turns are a person's own
  evidence (ticket 04).
- **Talk about someone absent** is not a second exchange: it is a mention inside the exchange it was said in, found
  by one of the focused reads. A mention holds who is meant, who tells it (him or the other person), who listens, and
  the quote. It is evidence about the absent person in its own vantage ("as he tells it to A", "as A tells it"),
  about him and the listener (what he confides is depth), and about him (his view).
- **An unnamed person** ("elle", "lui") is resolved by that read from the whole exchange and the people in his life
  then (the call's `involved`). The words used are kept; a guess is stored as a guess, shown as one, and can be asked
  in a fact check (today's `guessed-person` doubt).
- **Assistant chats** (ChatGPT, Claude) are not exchanges: nothing passes between two people. They stay his own
  writing, read for what he says of himself (what he feels, intends, decides, thinks) and for his mentions of people,
  with an assistant as the listener, a vantage of its own. The assistant's replies are context only.
- **Group chats and recordings with several people**: one exchange holds everyone's lines. Each coded act names who
  did it and to whom, so a person's conduct toward others ("with others") is kept apart from their conduct with him.
  A sitting is read when he speaks in it, or when the group is small and someone who also talks with him one to one
  speaks in it (the family group, a project's group). "Big" is set from his data at the pilot.
