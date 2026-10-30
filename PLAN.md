# Life's pages on Vite, React and Tailwind

Life's pages move to one front app, `apps/web`: Vite, React, TypeScript, Tailwind v4, TanStack Router (Better-T-Stack's
front); many pages are coming. The back stays Hono on Bun with Life's own sign-in (one issuer), no tRPC/oRPC, no
Turborepo. The app owns `/` (its data under `/api/`); the decisions page is rebuilt first, with a layout that fits the
screen by construction. The portrait is parked as legacy: its files stay served as they are at `/me/<name>`.

## Requests (owner, 30 Oct)

- [x] Typing in an answer did nothing (PR #307)
- [x] Decisions page: swipe and one-per-screen fail in practice because content overflows; rebuild it window-size aware, keeping its intent
- [ ] Move every page to Vite + React + Tailwind; rebuild from scratch where it is cleaner; many pages are coming
- [x] The portrait was a one-off: parked as legacy, served as it is
- [ ] Decisions that send him to the computer ("relancer railway login") add friction: the loops should do it or not ask (life-loops, needs that repo and the 1Password answer)

## Milestone 1: the decisions page in apps/web

- [x] His steps' shapes in `records/decision.ts`: one zod schema per owner step's `data` (`answered`, `context`,
      `revoked`, `asked`), parsed by the route and read by the fold for those steps; loop steps' data stays as it is
      (a stricter read could make his existing lines unreadable: `rowsOf` throws on the first bad line).
- [x] `Decision` (now `memory/decisions.ts:12`) and the page's row (`Decision` plus `to`) move to `records/decision.ts`.
- [x] `/api/decisions` (was `/me/decisions.json`) GET and POST, POST parsing his step with those schemas (no hand
      check against `OWNER_STEPS`); `/me/decisions` redirects to `/decisions` (links in sent emails). The page imports
      the row type from `records/` (type only: a fallow zone lets `apps/web` import `records/` and nothing else).
- [x] Sign-in in the app: `sign`, `signedIn` and the failure cap leave `createPortrait` for one module
      (`host/http/sign-in.ts`), used by the legacy portrait and `/api/`; `/sign-in` (a route), `POST /api/sign-in`;
      `next=` is followed only when it is a same-origin path; every `/api/` answer is 401 before it, and the app routes there. The legacy portrait sends a signed-out
      visit to `/sign-in?next=`. Delete the sign-in HTML string in `portrait.ts`. The pairing page (`oauth.ts`) moves
      when the next pages land.
- [x] `apps/web` workspace: Vite 8, React 19, TypeScript (its own tsconfig with DOM and JSX, its own check step),
      TanStack Router 1 (file routes), Tailwind 4 (`@tailwindcss/vite`) with its
      theme read from `assets/brand/tokens.css` through `@theme` (one source), TanStack Query 5 (poll every 20 s,
      paused while an answer is saving, refetched after it), Base UI 1.9 (the overview's Drawer, swipe to close,
      focus trapped; the options' RadioGroup).
- [x] The page's logic (`orderOf`, `nextOpen`, `isOpen`, `noteAnswer`, `tapAnswer`) as typed `apps/web/src/order.ts`;
      its cases move with it, and the two 30 Oct regression cases are ported, not dropped: a key other than Escape
      reaches his answer, and the desktop never snaps.
- [x] Layout, one model at every size:
  - The shell is exactly the visible viewport: `100dvh`, and with the phone's keyboard up the Visual Viewport's
    height (`useVisibleHeight`, one hook; iOS Safari has no `interactive-widget`), so nothing sits under the keyboard
    or Safari's bar.
  - One decision per screen, side by side, with native horizontal scroll-snap (axis-locked by the browser: a
    sideways swipe moves, an up-down drag scrolls the decision). The segment bar shows the position.
  - A decision on screen is three rows: where (fixed); the question, recipient, draft and context (the only part
    that scrolls when too tall); the answer, options and "say it your way" (pinned to the bottom, above the keyboard
    and the safe area). The question's size follows the width and its length (container units, `clamp`).
  - While his note has focus the row doesn't swipe; answering moves to the next open one, as today.
  - From 900 px: the overview is a sidebar, no snap, arrow keys and buttons move. Below: a Drawer from the top.
  - The current decision is its id in the hash (a link opens on it); which one is on screen is derived from it.
  - His unsaved note is local per decision; a refetch never replaces a field that has focus.
- [x] Serving: one constant, `WEB_DIST` (`core/paths.ts`, under `LIFE_CODE_DIR`), read by the portrait's Hono app,
      `scripts/helper.ts` (which builds then copies it) and `bun run check` (which builds it). The app's Hono
      route serves `/app/<hashed file>` (Vite's `assetsDir`, apart from the brand's `/assets/`; a name pattern, no
      traversal) and `index.html` only for a GET that asks for HTML outside `/api/` and `/.well-known/` (so OAuth
      probes and unknown API paths still get their 404; the route names stay in the router only). The bundle is Life's code only; nothing of his before `/api/` checks
      the cookie. The app's CSP is `'self'` plus Google Fonts.
- [x] Layout test: Playwright (Chromium) at 375×667, 393×852 and 1280×800 with a long question, a long draft and four
      options (no horizontal overflow, the answer row on screen, every part reachable, typing lands), as its own
      script like `check:offline`, not in the default gate.
- [x] Delete `assets/decisions/`, `scripts/decisions-page.test.ts`, the decisions branches and `/decisions.json` of
      `portrait.ts`, its `/*TOKENS*/` splice and sign-in form, the casts in the fold, the dead fallow entry `assets/**/*.tsx`; update
      `portrait.test.ts` and every doc naming the old paths (`AGENTS.md`, `docs/architecture.md` "Pages" and its CSP
      sentence, `docs/brand.md`, `docs/glossary.md` (and overview), `docs/SCHEMA.md`, `records/decision.ts`'s comment).
      The redirect keeps the hash.

## Later

- [ ] The pairing page into the app, with the next pages.
- [ ] The legacy portrait: delete it when it stops being fun (`assets/portrait/`, its routes).

## Golden rule plan
Inventory (`rg -n "assets/decisions|decisions\.js|DECISIONS_|assets/portrait|player\.js|TOKENS|OWNER_STEPS"`, `rg -n assets scripts/helper.ts scripts/app.ts .fallowrc.json`, `rg -n "dist" .gitignore`):
`assets/decisions/index.html` (356) and `decisions.js` (564, its own untyped decision shape);
`scripts/decisions-page.test.ts` (with the 30 Oct `keyDown` and snap cases); `portrait.ts:26-68` (`fileOf`),
`:36-41` (CSP), `:134-205` (`decisions`: an untyped body checked by hand), `:230-236` (the `TOKENS` splice);
`portrait.test.ts:136-216`; `records/decision.ts:63-73` (`DecisionLine.data` a bare record) and
`memory/decisions.ts:30-58` (the fold casting it); `http.ts:8` (`TOKENS`, kept for sign-in and pairing);
`scripts/helper.ts:31`; `.fallowrc.json:5-7`; `.gitignore:9`; `docs/architecture.md:175-182`, `docs/brand.md:18`.
Shape: each step's data has one schema in `records/`, parsed by the fold and the route; the page imports the type.
The brand lives once, in `tokens.css`, read by Tailwind. One path constant for the build. One layout model at every
width; the desktop switches only the overview and the input.
State: the decisions are server state (Query cache); the current decision is its id in the hash, the one on screen
derived; his unsaved note is per decision, local until he leaves the field.
Deletes: `assets/decisions/` (920), the page's copy of the decision shape, the hand body check, the fold's casts,
the decisions branches of `fileOf`, the `TOKENS` splice for this page, a dead fallow entry.
Net lines: about +600 / −1000.
Plan review: reshaped after the first review: step schemas in `records/` (the route alone would have been a second
shape); the regression cases ported; CSP, `base` and an assets branch; one `WEB_DIST` built by check and helper; the
hash holds the id; native snap instead of Embla; Playwright out of the default gate; types from `records/` only, not
`hc` (it would pull the server's graph into the page); sign-in and pairing stay server HTML. Kept against the review:
Base UI's Drawer (swipe to close and focus trap, which `<dialog>` lacks) and Query (pausing the poll during a save).
Second review: Base UI and Query accepted; his own steps only get schemas (loop lines stay readable), `Decision`
moves to `records/`, apps/web gets its own tsconfig. Then the owner's answer (many pages coming, portrait parked)
brought the router, the app at `/` and its sign-in.
Third review: the bundle under `/app/` (the brand owns `/assets/`), the catch-all limited so 404s stay 404s, one
sign-in module, `next=` checked, every doc naming the old paths updated. No further round.
