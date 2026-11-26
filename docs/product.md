# What Life shows, and when

Explanation: the rules for anything a person sees from Life — the iPhone app, a future Mac app, notifications, mail
— and why. Read it before designing or changing any of them. How it looks is [`brand.md`](brand.md); this page is
what appears, when, and what Life does without asking. "The person" is whoever uses Life (today, the owner).

## The principle

Do everything that can be done without the person. Show only what needs them, or what they asked for.

It comes from the owner's directions of 22 Nov 2026 ("Life takes care of shit for you in the background… anything that
really, really we cannot do and actually needs you, then we spoon-feed it to you"; "make the technology disappear")
and of 23 Nov 2026 ("Never show anything useless to the user. Only show what actually needs them, or what they asked
for"). The bar is a 70-year-old who doesn't know how to use an iPhone.

The yardstick for the app's design (his word of 23 Nov 2026): a good human assistant gets almost everything done with
him in an iMessage or WhatsApp thread. What they can do there, Life can do in its own thread, and better, since it owns
the screen (cards with answers, a draft shown as it will go, a map link, an ask that closes itself). A screen, view or
control that such an assistant would never need is a sign the design serves the builder, not the person.

## Why this is hard

A menu is an app saying "I don't know what you want, so here is everything." Apps, Apple's included, can't judge
what matters to someone at a given moment, so every feature must be reachable by navigation, and that is where depth,
settings screens and features found only by exploring come from. Life can judge: it reads the person's life and has
an agent in it. So it can replace navigation with judgment. Judgment can be wrong, and the rules below are what make
that safe.

## The rules

1. The two wrongs are not equal. Showing something useless costs seconds, and over time teaches the person to
   ignore Life. Hiding something that mattered loses a deadline, money or someone waiting, and trust goes at once. Show
   it when missing it costs something that can't be undone; otherwise Life handles it or stays silent.
2. Silence must be trustworthy. Silence means "all handled" only if Life reliably says when something is broken.
   So what is wrong and needs the person comes before anything else (the Mac unreachable, the pendant not recording, a
   login expired, the budget about to be passed), and Life shows it is present without reporting (the edge, "Life is
   working on it"). What Life can fix itself it fixes, unseen. What is degraded but works shows nothing.
3. Acting without asking is a ladder. Which rung an act takes depends on whether it can be undone and whether it
   is in the person's name or spends their money:

   | Rung | Examples |
   |---|---|
   | Do it, leave no trace | reading, sorting, settling what is obvious (a dated step past its day) |
   | Do it; found when asked | a to-do ticked, a fact corrected, an agent started on a matter |
   | Do it, say so once | an appointment agreed in a chat, added to the calendar, removable |
   | Ask first, with the exact thing | anything sent in their name, anything that spends money, anything irreversible |

   The top rung is an invariant ([`AGENTS.md`](../AGENTS.md): sends only on a card's draft, on the person's answer).
4. Hidden is never unreachable. What is not shown is there when asked: "what did Life do today?", "show me my
   settings". The conversation is the way to anything; the screen holds only what needs the person.
5. When matters as much as whether. A card in the middle of a conversation with someone is useless then, even if
   it matters. Notification levels and deadlines decide part of this; where the person is and what they are doing
   should decide more.
6. Ask well, so as to ask less. One decision per card: what, why, and what each answer does. The likely answer
   ready to tap. Never ask what Life can read, never ask twice what was answered, and never remind someone of what they
   already know. Code holds the card's part of this (`CARD_SELF_CHECK`, `memory/card-request.ts`).
7. A few things stay on screen. Where the stakes are immediate, a button beats a conversation: what is waiting on
   the person, the pendant (pausing in front of someone must be one tap) and what is broken. These few are the only
   fixed points; everything else Life brings up. The phone opens on them (his yes of 26 Nov 2026): at launch, or back
   after 5 minutes away, a clean screen greets him, then what is broken (never capped, each opening in place), then at
   most 3 asks that block him and a pill for the rest; the count stays the full total. The past is one Show earlier
   away, a day at a time. Back sooner, nothing changes; unsent words in the field stay either way.
8. Life's insides never show; what it did always can. No agents, roles, steps, models or prompts on screen (agent
   health lives only in Settings' diagnostics). What was done is always findable, and undoable where it can be.
9. An empty screen is a valid screen. Never fill it to look busy, and never say all is well.

## Money

Life's paid services run under one monthly amount the person sets. It is a soft cap (the owner's choice of 23 Nov
2026): Life projects the month from its spending (`read_spending`) and, before passing the amount, asks once whether to
raise it or slow down. Past it, Life first slows what can wait (handing matters out, backfills, background models) and
never stops recording or answering. A prepaid balance about to run out is asked the same way. Whether fixed
subscriptions count toward the amount is open. Not built yet: [the chat-first plan](plans/2026-11-23-chat-first-app.md).

Next: [`brand.md`](brand.md) for how it looks.
