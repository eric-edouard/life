# Roadmap

Explanation: what Life builds next, in order, and what is parked. No dates. Each item gets its own plan in
`docs/plans/` when it starts.

Life's core works for its one user: capture from every source, the days and facts, each person's page and where things
stand, the matters with what got done and how each ended, how each person writes, a summary of each long
conversation, who was talked about, the nightly report and the connector for Claude and ChatGPT. The personal parts
are add-ons, off until switched on. What comes next makes it a product for people other than its author.

## Before the live app

In this order: each one makes the next one simpler.

1. The README and this roadmap, written for someone who has never used Life.
2. Small leftovers: the one-time settings migration removed now that it has run; Life.app built and tested by
   `bun run check`, which skips `apps/mac` today; the report's mail key and sender name made the install's own.
3. One registry of the night's steps: each step's name, its switch, whether it may stop the night, and its run, so a
   step that fails no longer stops the whole night.
4. Scaling to ten years of data: a night reads a bounded span; the exchange counts are kept per month; a portrait is
   built from its last version plus what is new; search and `read_day` are served from the index; verdicts are split
   by month; digests hold refs, not names, so a rename re-reads nothing; the status check reads a file.
5. Typed reads for his apps, through the connector (no second API, `docs/architecture.md`, "Pages"): matters, the
   inbox and his agents are JSON (18 Nov 2026); a day and a person are still prose for a model. One of the two
   things called "status reads" gets a new name.
6. Later: `memory/` split into zones (the readers apart from the model steps), and AGENTS.md cut to the rules that
   protect data.

## Packaging and onboarding

Everything happens in the Mac app at first run, the setup interview included: a screen in the app, never an assistant.
The gaps, biggest first:

- A signed, notarized, downloadable Life.app.
- Lifelog Host inside Life.app, so the pendant needs one app on the Mac.
- lifelog's iPhone app on TestFlight.
- A model engine signed in without Terminal (OpenRouter first).
- Bridges linked from the app (a QR code, a code, a browser sign-in), with prebuilt binaries.
- Tailscale guided step by step, or another way to reach Life.
- One read of every part's state for the flow, and a Sources screen.
- Screens for what has none yet: the email report, backups, the calendars, Google Tasks, pairing an agent.

## Sending

Life sends nothing today. Sending starts with drafts: Life writes the message, and it is sent only on the owner's tap,
approved in the live Mac or iOS app. Every network goes through Life's own bridges, never Beeper, reactions included.
An approved message is the owner's words, kept out of how the owner writes. First comes a build spec: one send path,
a store of drafts, the approval screen, a guard against injected content, and the AGENTS.md rules it changes. It
waits on the owner's yes.

## Parked

Each picks up from where it stopped.

- Portraits rebuilt from their last version plus what is new (also part of scaling, above).
- Years and what repeats with a person, read from the months; the owner as the one observed (months, hours and money
  against the goals); forecasts, logged privately and scored later. Each starts with a set of question cases.
- Making memory easier to find: a short first page for each subject, and Life answering a question with its own reads.
- Naming voices from context: it runs, hidden, and is shown once its likely guesses are wrong less than once in 100.
- Relationship readings: stored, their switch hidden until something shows them.
- The backfill of older months through the models, after the scaling work.
- Labels in prompts that still name the owner by a pronoun (issue 558), each at its step's next prompt version.
- A server version ([server plan](plans/2026-10-22-server.md)), structured logging, and people reconciled by each
  source's own identifiers (handles, phones, emails) rather than voice.
- Windows. The platform module and the Windows fixes stay as seams; what a restart would need is at the end of the
  [platforms and modules plan](plans/2026-10-22-platforms.md).
