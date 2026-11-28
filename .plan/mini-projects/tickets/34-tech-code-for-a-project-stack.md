---
type: research
blocked_by: [18]
assets: [.plan/mini-projects/assets/34-code-for-a-project-stack.md]
---

# Technical: the code-for-a-project stack

## Question

The stack, architecture rules, tools and environment of the skill for projects that need code: what an agent builds
with, what it may and may not do, checked against current docs.

## Answer

Decided with the owner on 28 Nov 2026, from the research note (the asset).

- **The skill is `code-for-a-project`**, for projects that need code. Projects without code get their own skill, a
  separate effort.
- **A ladder; the agent stops at the first rung that is enough:** a **script** (Bun + TypeScript, `bun run`, CLIs from
  the allowlist, a restore log); a **page** (Vite + React + Tailwind, data baked in as JSON, published as a Life page;
  every preview is one); a **live app** (one `server.ts`: `Bun.serve` serves the Vite-built page and `/api` on one port,
  `bun:sqlite` in strict mode with WAL, uploads in a folder, guests reach it by personal links holding a token, never
  passwords). A **full app** (accounts, many users, payments) is named and out of Life's lane for now.
- **No** Better-T-Stack (always a monorepo, dozens of files), Next.js, ORM, router library, Docker or Postgres. One
  folder, one `package.json`.
- **UI:** Tailwind only, no component kit, guided by a frontend design skill.
- **Rules:** fewest files, plain SQL, one source of truth (SQLite or JSON), zod at every boundary, a restore log then a
  sample then batches before touching the user's things.
- **Checking its own pages:** `agent-browser`: the accessibility tree and console errors first, then two small
  screenshots (phone and desktop).
- **May:** its project folder, Life's memory through the connector, the Mac access Life holds, allowlisted CLIs,
  packages installed inside its folder, well-proven skills from `find-skills`. **May not:** send anything, install
  outside its folder or off the allowlist without the owner's yes, touch the user's things outside an approved batch,
  put anything online except through Life's pages, add a second stack.
- **osxphotos** stays on its latest release and is updated after each macOS update.
- **Public origin:** a page or live app is reached at the install's `hostedbyme.app` address (the private relay,
  `docs/plans/2026-11-27-private-relay.md`; the Mac serves it with its own certificate).

Built: https://github.com/eric-edouard/life/pull/1588
