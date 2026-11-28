---
name: engineering-playbook
description: How a one-off project's agent works, from the first look to done. Read it at the start of every one-off project and follow every step.
---

# Engineering playbook

The aim: a result that looks and feels great (the approved preview), works with no bugs, and costs few tokens. Scrappy, not production.

## Every wake

- Your folder is the project's work folder, with its own git. Work there; nothing of yours goes elsewhere.
- After a restore (it leaves out `.git` and `node_modules`): no `.git`, run `git init`; `package.json` with no `node_modules`, run `bun install`.
- Read `PLAN.md` first; tick a box only after its step is checked.
- Never commit a secret (a key, token or password); a backup leaves out files starting `.env`.
- One commit per checked step. No GitHub, no PR, no remote.
- Weigh every step's token cost: small command outputs, files read by range, no full logs.

## Before building

- Read what bears on the ask before planning; never ask what you can find out.
- First look: read only on the user's things until they approve a preview.
- Look for relevant skills with `find-skills`; take only well-proven ones (many downloads), installed in this folder.
- Write `PLAN.md`: plain steps with checkboxes, the time and the cost.
- The preview is the cheapest thing that shows the result (a clickable fake, a sample, an outline), never their real things.
- Their approval of the preview is approval of the plan; a change or a cost over the cap is asked again.

## Building

- Code: follow `code-for-a-project` (beside this skill, `../code-for-a-project/SKILL.md`). One stack: Bun and TypeScript.
- Tools outside the stack: only the allowlist below, installed by you, called from Bun scripts.
- Anything else off the allowlist or the stack: never; tell the user it can't be done that way.
- Minimal code: fewest files, nothing for later.

## The user's things

- A restore log before any change, so every change can be undone.
- A small real part first, then batches.
- A delete or an overwrite of their things needs their yes on that batch.

## Proof

- Use the result as the user would: run the script on a sample, open the page and look.
- Tests only where a mistake can't be undone: deletes and writes to their things.

## Review

- Once, on the result, before "done": a fresh session on your own model, given the preview, `PLAN.md` and the running result.
- It judges against the user's ask, never taste: a finding that doesn't change whether the result does what they asked is dropped.
- Another round only when a finding justifies it. Never review your own work in your own context.

## Stuck

- Revert each failed fix before the next.
- After two failed fixes, rethink and re-plan once.
- After that, stop: tell the user plainly what works, what doesn't, and what you suggest (drop that part, or another way).
- A bug you can't fix is told to the user plainly, never hidden.

## Allowlist

- `osxphotos` (Photos library; always its latest release, updated after each macOS update; "no such table" means update it).
- `exiftool` (file metadata).
- ImageMagick (`magick`: images).
- `agent-browser` (checking your own pages).
- Adding a tool takes the yes of Life's developer, who writes this playbook; never ask the user.
