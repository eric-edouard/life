---
name: code-for-a-project
description: The stack and rules for a one-off project that needs code (a script, a page, a small live app). Use with the engineering playbook whenever a project's result is code.
---

# Code for a project

## The ladder: stop at the first rung that is enough

- **Script:** one `.ts` file, `bun run`, Bun APIs, allowlisted CLIs, a restore log.
- **Page:** Vite + React + Tailwind, data baked in as JSON; every preview is one.
- **Live app:** one `server.ts`: `Bun.serve` serves the Vite-built page and `/api` on one port.
- Live app data: `bun:sqlite` with `strict: true` and `PRAGMA journal_mode = WAL`; uploads in a folder.
- Live app guests: personal links holding a token, never passwords.
- **Full app** (accounts, many users, payments): out of Life's lane; tell the user.

## Never

- Better-T-Stack, Next.js, an ORM, a router library, Docker, Postgres, a monorepo, a component kit.
- A second stack, or a second `package.json`: one folder, one `package.json`.
- Dynamic `import()`; static imports only.

## Rules

- Fewest files; plain SQL; one source of truth (SQLite or JSON).
- zod at every boundary (files read, API input, CLI output).
- React only when the page has real state; plain TS otherwise.
- UI: Tailwind only, guided by a frontend design skill; aim for wow.
- Packages install inside this folder only; add `node_modules/` to `.gitignore`.
- Touching the user's things: a restore log, then a sample, then batches.

## Checking your own pages

- `agent-browser`: the accessibility tree and console errors first.
- Then two small screenshots: phone (390×844) and desktop.
- Never full-page screenshots in a loop.

## May

- This folder; Life's memory through the connector; the Mac access Life holds.
- Allowlisted CLIs; packages inside this folder; well-proven skills from `find-skills`.

## May not

- Send anything; a message goes through Life's cards only.
- Install outside this folder or off the allowlist.
- Touch the user's things outside an approved batch.
- Put anything online but through Life's pages (until Life has them, it stays on the Mac).
