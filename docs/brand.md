# Life's brand

<img src="brand/reference.png" alt="Life's brand guide: the wordmark, icon, type, palette, shape and principles" width="512" />

The image is a visual reference; the exact values are the brand guide's and `assets/brand/tokens.css`'s.

A private memory. Calm by nature, personal by design. Everything Life shows follows this page: the nightly email,
the web app, the pairing page, the app (menu-bar panel, status window, settings, first run) and the icons.

## The values

One source: [`assets/brand/tokens.css`](../assets/brand/tokens.css), its fonts' `@import` included, so a page that
inlines or links it first gets them. Pages inline it or link it (first, before any rule of their own); the two surfaces
that can't read CSS variables copy its values, and `scripts/brand.test.ts` fails when a copy drifts:

| Surface | How it takes the tokens |
| --- | --- |
| The web app (`apps/web`) | `tokens.css` imported first in `apps/web/src/styles.css`; Tailwind's `@theme` only names its values |
| The pairing page | `TOKENS` (`apps/server/src/host/http/http.ts`) inlined in its styles (`oauth.ts`) |
| What the agent makes for the owner | `<origin>/docs/brand.md` and `<origin>/assets/brand/tokens.css`, served open (`apps/server/src/host/http/server.ts`) |
| Every email (the nightly, the reports, the alerts) | `C`, `RADIUS`, `SERIF`, `SANS` and `MONO` in `apps/server/src/memory/email.ts`, copied (mail takes no variables), light only |
| The Mac app (parked) | `Brand` and `Tone.color` in `apps/mac/Sources/LifeApp/Brand.swift`: its colours copied; its fonts are still the old ones |

No other file writes a colour: the test also fails on a hex colour anywhere else in `apps/server/src`, `assets`, `apps/web/src` or `apps/mac/Sources`.

- **Colour.** Grey does the work: ink `#1F1F1F` (titles, the one primary button), text `#4A4A4A`, muted `#6B6B6B`
  (labels; passes on ground and on card), rule `#E3E3E3`, ground `#F6F6F6` (the page, never pure white), card white
  `#FFFFFF` (what sits on the page, and the text on ink). Two status colours, each always
  beside a word, never as text: green `#15803D` only for done (a check), red `#B42318` only for a problem (a dot).
  The other status tokens mark only the parked Mac app's dots.
- **Dark.** Derived, the calm inverse: ground `#1F1F1F`, ink `#F2F2F2`, text `#C9C9C9`, muted `#A3A3A3`, card
  `#2A2A2A`, rule `#3A3A3A`; green `#4ADE80` and red `#F97066`, lightened to read on the dark ground. Each colour's pair
  is one `light-dark()` in tokens.css. Pages follow the system unless one sets `data-theme` (the decisions page's
  Theme switch, kept in his browser); the email stays light.
- **Type.** Literata (500, 600; 700 for the question on a wide screen) for titles and the questions he answers; Atkinson Hyperlegible Next (400, 500, 700),
  drawn so no two letters are mistaken, for everything he reads and taps; Atkinson Hyperlegible Mono for times, money
  and ids. Mail loads no web font: titles show in Georgia, text in the system sans.
- **Hierarchy.** Size and weight carry it, not colour: one question at a time, large; one dark button for the
  recommended answer, the others outlined; labels small and muted.
- **Shape.** Controls 12 px radius, panels 18 px, icon strokes 1.5 px, spacing 8, 16, 24, 48. No paper texture,
  gradients or decorative shadows.
- **Cards have no border** (owner, 30 Oct 2026): a card, a panel, an option or a field stands out from the ground by
  its white (card) only, and a field inside a card takes the ground (owner, 31 Oct 2026); a chosen one is filled (ink, or green for his answer). A rule line separates rows
  of a list, never draws a box (`scripts/brand.test.ts` checks the web app).
- **Parked (30 Oct 2026).** The Mac app's UI keeps its old layout and fonts, with the colours above; lifelog's apps
  (iOS, Android) keep the old look until they are stripped; Android's `Brand.kt` and lifelog's `docs/design.md` describe that old look.

## The mark

- **Wordmark.** "Life" in Cormorant Garamond Bold, only the L italic, outlined as one drawing:
  [`assets/brand/life.svg`](../assets/brand/life.svg) (the guide's L and its Cormorant "ife", set as the guide sets
  them). No surface sets it as text, so Cormorant ships nowhere. Leave one x-height clear around it.
- **Icon.** The white L on ink, a rounded square with 22% corners: [`assets/icon/icon.svg`](../assets/icon/icon.svg)
  (the README's, `/icon.svg`, rendered to `icon-512.png`), and `app.svg`, the same on macOS's icon grid.
  `scripts/app.ts` renders `app.svg` into `Life.icns`, and `life-l.svg` (the L alone, the menu bar's) and `life.svg`
  (the `Wordmark` view's) into template PDFs.

## Principles

Give the words room. Keep the source close: show where a memory came from. Make colour useful: status only.

Fonts are under the SIL Open Font License. Web pages load Literata and Atkinson Hyperlegible from Google Fonts, through
`tokens.css`; the parked Mac app still bundles its old fonts in `apps/mac/Fonts`.
