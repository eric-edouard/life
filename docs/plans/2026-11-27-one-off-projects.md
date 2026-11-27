# One-off projects

Explanation and plan: how a user hands Life a long piece of work ("organize and clean up my photo library") and an
agent carries it to its end, asking the user only what is theirs. Not built. Waits on the owner's answers at the end.

## The case that started it

A first user asked (27 Nov 2026): about 10,000 photos in the Photos app and about a thousand albums; clean it up, keep
what matters, and find an album system that works. What "clean" and "organized" mean is hers to say. Everything else,
the agent should find out itself.

This is one case of many: sort my Downloads, file my receipts for taxes, move my notes out of an old app, plan a move.
Nothing below is about photos.

## What it is

A one-off project is a project (`truth/` `Project`) the user starts with their words, that has a goal and ends when the
goal is met. It is not a matter (something Life notices in the user's life), and not handed work (a quick job the main
session passes to an agent, done in a turn or two).

Life's projects already have most of it: an entry in the directory with a status (`active`, `waiting`, `parked`,
`done`), one agent per project that starts in the project's folder, a project situation (where it stands, what is
blocked and on whom), and cards for what needs the user. What is missing is listed below.

## What the user sees

1. They say it, through Ask Life: "Organize and clean up my photo library."
2. Life answers that it is on it, and a project appears with its goal.
3. After a while, one card with a few questions, each with a recommended answer, and the plan their answers lead to.
4. Progress on the project's page: what is done, what is next, what waits on them.
5. A card before each batch that deletes or rewrites their things, showing the exact batch.
6. A last report, and the project is done.

Nothing else. No agent names, no phases named, no technical words.

## How the agent works

The brief of a one-off project's agent gives it this way of working, in order:

1. **Check what it can do.** Before asking anything: can it read what the goal is about (here: is the library on this
   Mac, through iCloud Photos, with its originals or only previews), can the model see it (images, PDFs), what tools
   the Mac has, how big the job is, what it will cost and how long it takes. What it cannot do, it says plainly in its
   first card, with what would unblock it.
2. **Ask once.** One card holding the few questions only the user can answer, each with a recommended answer and
   what each answer does, and the plan their answers lead to (`plan` on the card). Never a question it can answer
   from what it read.
3. **Work in batches.** It works where it is safe without asking (reading, sorting a copy, writing scripts in the
   project's folder, trying them on a small sample first). Anything that deletes or rewrites the user's things waits
   for their yes on the exact batch.
4. **Keep its plan in the project's folder** (`PLAN.md`, ticked as it goes), so a compacted session, a restart or
   another agent picks up where it stopped. Its progress is what the project situation reads.
5. **Finish.** A short report of what changed and how to undo it, then the project is marked `done` and its agent ends.

## What to build

### 1. A project the user starts

Today a project is added only through `change_directory_entry`. A one-off project needs:

- A `goal` on `Project` (one line, the user's words) and `kind`: `ongoing` (today's projects) or `one-off`. A new key in
  `truth/` lands in code first (the schemas are strict).
- The main session creating it from the user's ask, and starting its agent, in one act.
- A folder for it under the agents repo (`<agentsRepo>/projects/<id>/`) as its `repos` entry, when the project has no
  repo of its own: the agent's working place, its `PLAN.md`, its scripts.

### 2. The one round of questions

A card holds one question today. A one-off project's first card needs several, answered together on the phone. Two
ways, to be chosen:

- **A questions card:** 2 to 5 questions on one card, each with 2 or 3 options and the recommended one first. A new
  card shape, in `memory/card-request.ts` and the app.
- **An interview through Ask Life:** the agent's first card says "a few questions about your photos" and opens a
  short conversation with the main session. No new card shape, but the user types.

Recommended: the questions card. Tapping beats typing, and it fits the one inbox.

### 3. Approval before destructive acts

Today an agent can delete any file on the Mac (SECURITY.md, "Agents"). Only sends are refused in code. For a one-off
project that touches the user's things, that is not enough.

- A new need on a card, `batch`: what will be deleted or changed (a count, a sample the user can see, where it goes
  and how to undo it). The agent acts only after the user's yes on that card.
- Undo first: prefer acts the system can take back (Recently Deleted in Photos, the Trash in Finder) and say how long.
  An act with no undo needs a copy made first, and the card says so.
- Enforcement: the send guard cannot see a script that deletes photos. So this is the brief's rule, not code's, the
  same as SECURITY.md already says of everything past the guard. Say it there plainly.

### 4. Images and PDFs

The agents' model (DeepSeek V4.1 Flash, on DeepInfra and Morph) reads images: tested 27 Nov 2026 on both hosts, and pi
is set to pass them (`pi-runtime.ts`, `input: ["text", "image"]`). Still to check: whether pi's file reading passes a
PDF to the model, or only its text; if only text, the agent turns pages into images with `sips`.

Privacy: Life's own photo descriptions run on the Mac (the owner's decision of 11 Nov 2026), so photos never leave it.
An agent looking at photos itself sends them to the model's host. The first card of a project that would do this says
so, and offers the on-Mac way when one exists (here: reading Life's own descriptions instead).

### 5. Cost and time

The first card carries the agent's estimate (time, money) and the project a spending cap, the same as an Apify run's
cap. The desk stops the agent at the cap and asks.

## Git on a user's Mac

Life uses git today: the memory's data repo commits every night, the directory's changes are read from it
(`read-truth.ts`), and the `git` source reads the owner's code repos. Agents also use it in their folders.

macOS has no real git by default. `/usr/bin/git` is a placeholder that shows "install the command line developer
tools" the first time it runs, and fails until the user accepts and waits for the download. On a fresh Mac, Life's
first nightly commit would hit that.

Neither GitHub nor an account is needed: the data repo has no remote, and the `github` source is optional.

Fix, in the packaging work (roadmap, "Packaging and onboarding"): bundle git inside Life.app, signed and notarized with
it, and put its folder first on the `PATH` of Life's processes and its agents' sessions. Git is GPL v2: shipping it
needs its source offered, which a link to the exact release does. The other way, replacing git with a library in Bun
(isomorphic-git), would change every git call for no gain.

## Open questions for the owner

1. A one-off project as a `kind` of project, not a new concept: agreed in conversation on 27 Nov 2026. Confirm the
   word `one-off`.
2. The questions card or the interview through Ask Life (recommended: the card).
3. Who may start a one-off project: the user's words only, or also an agent that finds a job too big for handed work
   (and asks with a card)?
4. A default spending cap per project, and what the user sees when it is reached.
5. Bundle git in Life.app: yes or no.

## Debt plan

- No new concept: `Project` grows two keys (`goal`, `kind`); the glossary's project line says what a one-off project is.
- The card's new parts go into the one registry of need kinds (`memory/needs.ts`) and the card shape, never a second
  card system.
- The agent's way of working is its brief's words, not code. Code only adds what the brief cannot do: the card shapes,
  the cap, the project's start.
- Delete: nothing today is replaced; check at build time whether "handed work" kinds overlap and fold them.
