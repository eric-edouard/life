# 34 — Stack for the `code-for-a-project` skill (research, 28 Nov 2026)

Question: what an agent (pi, one mid-size open-weights model) should use to build small one-off projects on the owner's Mac:
scripts, pages, small live apps with shared data. Fixed: Bun + TypeScript, Tailwind, no component kit.
Optimised for: UI quality, no bugs, low tokens (less for the model to read and write), boring.

## Recommendation

| Rung | Stack | Files the model writes |
|---|---|---|
| Script | `bun run x.ts`, Bun APIs only | 1 |
| Page | `index.html` + `app.tsx` (or plain TS) + `styles.css` (`@import "tailwindcss"`), served by `bun ./index.html` ([HTML & static sites](https://bun.com/docs/bundler/html-static)) | 3 + `bunfig.toml` |
| Live app | one `server.ts` with `Bun.serve({ routes })`: HTML import for the page, `/api/*` handlers, `bun:sqlite` for data, files on disk for uploads ([fullstack](https://bun.com/docs/bundler/fullstack), [bun:sqlite](https://bun.com/docs/runtime/sqlite)) | 4–6 |

React (plain, no router) only when the page has real state; plain TS otherwise. No ORM, no API layer, no router lib, no monorepo.
Fallback, documented in the skill: if `bun-plugin-tailwind` misbehaves, switch the page to Vite + `@tailwindcss/vite` (below); the server stays `Bun.serve` serving `dist/`.

Why: one process, one port, one dependency set (`tailwindcss`, `bun-plugin-tailwind`, optionally `react`, `react-dom`).
No proxy between two dev servers, no config but a 2-line `bunfig.toml`. Every API the model needs is in Bun's own docs,
which are short, so a mid-size model makes fewer wrong-version mistakes than with a framework stack.

## 1. Better-T-Stack and the alternatives

[create-better-t-stack](https://github.com/AmanVarshney01/create-better-t-stack) ([CLI docs](https://www.better-t-stack.dev/docs/cli)) scaffolds a typed full-stack app.
Choices: frontend (React with TanStack Router / React Router / TanStack Start, Next, Nuxt, Svelte, Solid, Astro, RN, none),
backend (Hono, Express, Fastify, Elysia, `self` = API routes inside the web app, Convex, none), runtime (Bun, Node, Workers),
database (SQLite, Postgres, MySQL, Mongo, none), ORM (Drizzle, Prisma, Mongoose, none), API (tRPC, oRPC, none),
auth (Better Auth, Clerk), addons (Turborepo, Biome, PWA, Tauri…). `--yes` takes defaults.
- Output is **always a monorepo**: `apps/*` + `packages/*`, with `packages/config` always present; Hono puts the server in
  `apps/server` (`src/index.ts`, `src/routers/index.ts`, own `package.json`, `tsconfig.json`) ([project structure](https://www.better-t-stack.dev/docs/project-structure)).
- Most minimal full-stack pick: `--runtime bun --backend hono --frontend tanstack-router --database sqlite --orm drizzle --api none`.
  Even that is two apps, a shared config package, Vite, TanStack Router (generated route tree), Drizzle + drizzle-kit + libSQL,
  several `package.json`/`tsconfig.json` files: dozens of files and on the order of 20+ direct dependencies (not counted
  by running it: nothing installed here; the structure doc is the source).
- Fit: good for a long-lived product a team grows. Poor for a one-off agent build: the model must read and respect far more
  scaffolding than it writes, and each layer (router codegen, Drizzle migrations, tRPC/oRPC) is a place a mid-size model errs.

Alternatives compared:

| Option | Moving parts | Verdict |
|---|---|---|
| **Bun.serve + HTML imports + bun:sqlite** | Bun only, + Tailwind plugin | **Pick.** Smallest surface, one process |
| Hono + bun:sqlite ([Hono on Bun](https://hono.dev/docs/getting-started/bun)) | + hono; still needs a page bundler | Worth it only for middleware (auth, validation, CORS). Bun's `routes` already gives params and per-method handlers |
| Vite (React) + Tailwind, Bun runtime | + vite, plugin-react, @tailwindcss/vite, vite.config.ts; second server or a build step for the API | Best page tooling, more files; see below |
| Better-T-Stack | monorepo, router, ORM, API layer | Too much for one-offs |

### Vite + Tailwind vs Bun's HTML bundler (owner's addition)

- **Maturity.** Vite 8 is stable since Mar 2026 on Rolldown ([announcement](https://vite.dev/blog/announcing-vite8)); Rolldown 1.0 in May 2026 ([post](https://voidzero.dev/posts/announcing-rolldown-1-0)); 8.1 in Jun 2026.
  Bun's fullstack docs still say "work in progress… APIs may change" ([fullstack](https://bun.com/docs/bundler/fullstack)); Bun is at v1.4.5 (19 Nov 2026, [releases](https://github.com/oven-sh/bun/releases)). Vite wins on maturity.
- **Dev server / HMR.** Both have HMR. Vite's is the reference implementation, with React Fast Refresh. Bun's: HMR on by default in
  `development`, plus `development: { console: true }` that streams browser console logs to the terminal — useful for an agent
  that cannot see the browser console.
- **Tailwind v4.** Vite: official `@tailwindcss/vite`, one plugin line in `vite.config.ts`, no `tailwind.config` ([Tailwind docs](https://tailwindcss.com/docs/installation/using-vite)).
  Bun: `bun-plugin-tailwind` in `bunfig.toml` `[serve.static] plugins`; still 0.0.x, with an open report of some classes not styling
  ([tailwindcss#19021](https://github.com/tailwindlabs/tailwindcss/issues/19021)). Vite wins here.
- **What the model writes.** Page alone: about equal (Vite adds `vite.config.ts` + 2 deps; Bun adds `bunfig.toml` + 1 dep).
  Live app: Bun wins clearly — the HTML route and `/api` live in one `server.ts`, one port. With Vite the model must run Vite's dev
  server plus a Bun API server with a proxy, or build to `dist/` and serve it from Bun: one more process or one more step to get wrong.
- **UI quality** comes from Tailwind + the design skill + screenshot checks, not the bundler: equal.

Pick: **Bun-native for both rungs**; Vite is the named fallback for the page bundling (if the Tailwind plugin misbehaves or a
page needs a Vite-only plugin), with `Bun.serve` still the server. If the owner weighs maturity over the one-process
simplicity, the honest second choice is "Vite for the page, `Bun.serve` serving `dist/` + `/api`" — not two dev servers.

## 2. Bun full-stack server and bun:sqlite

- `Bun.serve({ routes: { "/": indexHtml, "/api/rsvp": { GET, POST }, "/api/guests/:id": … } })`; HTML imports bundle `<script>`/`<link>`,
  transpile TS/JSX. API routes since v1.2.3; ahead-of-time build since v1.2.17: `bun build --target=bun --production --outdir=dist ./server.ts` ([fullstack](https://bun.com/docs/bundler/fullstack)).
- Dev (`development: true`): rebundles per request, source maps, HMR. Prod: in-memory cached assets, ETag, minified.
- Gotchas (same page): no SSR; bunfig plugins apply to `Bun.serve` static bundling and the `Bun.build()` JS API but **not the `bun build` CLI**
  (so the AOT build with Tailwind needs a tiny `Bun.build({ plugins: [tailwind] })` script, or just run in prod mode without AOT —
  fine for a local app); only literal `process.env.FOO` is inlined in the browser, others throw `process is not defined`;
  dynamic `import()`/`React.lazy` reported failing under `NODE_ENV=production` ([bun#19129](https://github.com/oven-sh/bun/issues/19129)) — skill rule: static imports only.
- Production readiness for this use (one user, LAN or tunnel, tens of guests): adequate. Run it as `development: false` under the Mac's supervisor.
- `bun:sqlite` ([docs](https://bun.com/docs/runtime/sqlite)): synchronous, prepared statements, transactions, `strict: true` (named params without
  prefix, missing params throw: use it), `safeIntegers` (bigint). Set `PRAGMA journal_mode = WAL` once. macOS note in the docs: the system
  SQLite keeps `-wal`/`-shm` files after close; harmless, or checkpoint with `wal_checkpoint(TRUNCATE)`. Stable and boring: the right default;
  no Drizzle needed for 2–3 tables (`CREATE TABLE IF NOT EXISTS` at start).
- Uploads: `await req.formData()` → `Bun.write("uploads/<id>", file)`; serve with `new Response(Bun.file(path))`. No library.

## 3. Headless browser for self-checking

- **Playwright** ([browsers](https://playwright.dev/docs/browsers)): macOS 14+ ([intro](https://playwright.dev/docs/intro)). Installed sizes in its own example: Chromium ~281 MB,
  WebKit ~180 MB, Firefox ~187 MB, in `~/Library/Caches/ms-playwright` (shared across projects: download once per Mac).
  `--only-shell` installs just `chromium-headless-shell` (smaller, headless only). WebKit is the closest to Safari, which the guests'
  iPhones run: use `webkit` for the check (180 MB, real Safari engine), Chromium only if a WebKit build is missing for a new macOS.
- **agent-browser** ([vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)): Rust CLI + daemon over CDP, downloads Chrome for Testing;
  `snapshot -i` gives a compact accessibility tree of interactive elements with refs (`@e2`), `screenshot --annotate` labels them. Made for
  agents; the most token-cheap ready-made option. Already a skill on this Mac. Chromium-only (no Safari engine).
- **Safari via safaridriver** ([Apple: WebDriver for Safari](https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari)): zero download, real Safari,
  W3C screenshots. But needs a one-time `safaridriver --enable` (admin) and "Allow Remote Automation", has **no headless mode** (opens a
  visible window in his session), one session at a time. Not good unattended. (Accessibility endpoints not verified.)
- Token-cheap use, for the skill: after each build step, (1) accessibility tree / `snapshot -i` text first (hundreds of tokens) to check
  structure, labels, buttons; (2) one screenshot at phone width (390×844) and one at desktop, at low scale, only for visual review;
  (3) read the browser console (Bun's `console: true` already pipes it to the terminal). Never full-page screenshots in a loop.
- Pick: Playwright WebKit through a 20-line `check.ts` (screenshot + `page.accessibility`/aria snapshot + console errors), or agent-browser
  where Chromium is enough. Note the model's own vision limits: a mid-size open-weights model may not read screenshots well; the aria
  snapshot plus console errors is the dependable signal, the screenshot goes to a vision-capable reviewer or the owner.

## 4. osxphotos on macOS 26/27

[Releases](https://github.com/RhetTbull/osxphotos/releases) track Apple's schema changes closely:
- v0.76.0 (Jun 2026): preliminary macOS 27 beta support, "will likely break with future beta releases"; v0.76.1 fixes 27 beta.
- v0.77.0 (Sep): macOS 27 search and captions (search moved to `leo.sqlite`, captions in typed tables); v0.77.1 restores search info on 27.
- v0.77.2 (27 Sep): **shared albums fixed on macOS 26+ / Photos 11** (reported in [#2003](https://github.com/RhetTbull/osxphotos/issues/2003));
  system library detection fixed on 27 (path moved into the photolibraryd group container).
- v0.78.0 (4 Nov): many `export --update` fixes; `%s` dates now in the photo's own zone (may rename files on `--update`).
- v0.78.1 (8 Nov): **macOS 27.3 beta schema** (tables renumbered, "no such table" error) fixed.
Takeaway: works on 26 and 27 if kept on the latest release; every macOS point release (27.3 next) can break it until a patch lands,
usually within days. Pin nothing; upgrade osxphotos before any run after a macOS update, and treat a "no such table" error as "update osxphotos".

## Skill rules this implies (draft)

1. Rungs: script → page → live app; climb only when the request needs it.
2. Live app = one `server.ts`, `Bun.serve` routes, `bun:sqlite` (strict, WAL), uploads on disk, static imports only.
3. Tailwind via `bun-plugin-tailwind`; on a styling miss, switch the page to Vite + `@tailwindcss/vite`, keep the server.
4. Check every UI step: aria snapshot + console errors first, then 2 low-scale screenshots (phone, desktop) in WebKit.
5. No ORM, router, API layer, auth lib, monorepo, Docker or Postgres for a one-off.
