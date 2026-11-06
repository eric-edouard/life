# Examples

Tutorial: what asking Life looks like, with real transcripts and questions to try.

Each transcript is a real run, trimmed, on a made-up person, Sam, whose week [`scripts/demo.ts`](../scripts/demo.ts)
writes: Claude Code with Life's read commands as its only tool (the script's header has the command). Claude.ai and
ChatGPT get the same reads through Life's connector. Each `obs_…` (a fact) and `ep_…` (an episode) id opens what it
cites and the message it was quoted from.

## Did I keep my promises?

> **You:** What did I promise my landlord last week? Did I keep it?
>
> *Claude reads Life: `search landlord`, `search rent`, `search apartment`, `day 2026-10-14`, `person jean-dupont`,
> `search plumber`, `day 2026-10-17`*
>
> **Claude:** You made your landlord, Jean Dupont, two promises on Tuesday 13 October over WhatsApp, and you kept both.
>
> **1. Pay the October rent by Friday 16 October:** kept, a day early.
> - The promise: *"I'll send the rent by Friday, sorry for the delay"* (obs_7938971d6db7)
> - On 15 October at 18:40 you wrote *"Done, the October rent is sent"* (obs_58f120ffa801, ep_33cb4cebbcea).
>
> **2. Be home Saturday 17 October to let the plumber in for the kitchen sink:** kept.
> - The promise: *"I'll be home Saturday morning to let the plumber in"* (obs_031fc9a8b3e7)
> - Your lifelog shows Hans fixed the sink at the flat at 10:00 that Saturday. He told you *"the drain pipe was cracked,
>   I put in a new one"* (obs_a5b48d28a3c9, ep_3d2da4745984).
>
> **Coming up:** on 21 October, Claire Dupont said she'll send the 2027 lease for you to sign before the end of October
> (obs_63f9c7b97304). That's something you're waiting on from her, not a promise you made.

## What's coming up?

> **You:** What's coming up in the next ten days that I shouldn't forget?
>
> *Claude reads Life: `person me`, `search upcoming deadline appointment`, `day 2026-10-21`*
>
> **Claude:** Two things in the next ten days (22 Oct – 1 Nov):
>
> 1. **Bring the cake to Ana's birthday dinner, Saturday 24 Oct.** You told Ana "Leave the cake to me"
>    (obs_6d8ac0e8764c).
> 2. **Watch for the 2027 lease from Claire Dupont by 31 Oct.** She said she'd send it for you to sign before the end
>    of the month (obs_63f9c7b97304). If it hasn't arrived by about the 31st, follow up with her, then sign it.

## Has my week matched my goals?

The README opens with this one: [ask it anything](../README.md#ask-it-anything). Life reads your goals from
`truth/me.md`, the one file about you that only you write.

## More to ask

About your days:

- Where was I on the evening of the 14th, and who was I with?
- What did I actually do last week? Walk me through it day by day.
- Where did my hours go this week: which apps, which projects?
- When did I last go climbing?

About people:

- How are things with Ana right now?
- What's my history with Leo? How did we meet, and how has it changed?
- Who have I been neglecting lately?
- When is Mia's birthday, and what did she say she wanted?
- Draft my reply to Hans, the way I usually write to him.

About what you owe and what's owed to you:

- What did I promise people this week that I haven't done?
- Who's waiting on a reply from me?
- What did Claire say she'd send, and has it come?

About what's gone:

- What did the message Leo deleted on WhatsApp say?
- What did my packing list note say before I rewrote it?

About you:

- Has my month been aligned with my goals? What should I drop?
- What have I said I want to change, and did I?

Next: [connect your assistant](use/connect.md).
