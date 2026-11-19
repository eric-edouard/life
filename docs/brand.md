# Life's brand

A private memory. Calm by nature, personal by design. Everything Life shows follows this page: the nightly email,
the pairing page, the Mac app (menu-bar panel, status window, settings, first run), the iPhone app and the icons.

## The values

One source: [`assets/brand/tokens.css`](../assets/brand/tokens.css), its fonts' `@import` included, so a page that
inlines or links it first gets them. Pages inline it or link it (first, before any rule of their own); the surfaces
that can't read CSS variables copy its values, and `scripts/brand.test.ts` fails when a copy drifts:

| Surface | How it takes the tokens |
| --- | --- |
| The pairing page | `TOKENS` (`apps/server/src/host/http/http.ts`) inlined in its styles (`oauth.ts`) |
| What the agent makes for the owner | `<origin>/docs/brand.md` and `<origin>/assets/brand/tokens.css`, served open (`apps/server/src/host/http/server.ts`) |
| Every email (the nightly, the reports, the alerts) | `C`, `RADIUS` and `SANS` in `apps/server/src/memory/email.ts`, copied (mail takes no variables), light only |
| The Mac app (parked) | `Brand` and `Tone.color` in `apps/mac/Sources/LifeApp/Brand.swift`: its colours copied; its fonts are still the old ones |
| The iPhone app, widgets and Watch | `Palette` in `apps/lifelog/apps/ios/Shared/Palette.swift`: the thirteen colours, dark and light, copied; the app follows the system's appearance |

No other file writes a colour: the test also fails on a hex colour anywhere else in `apps/server/src`, `assets`, `apps/mac/Sources` or the iPhone app's `Shared`.

- **The look is the app's** (owner's yes, 18 Nov 2026: the new app's look becomes Life's brand, replacing the grey
  one). Dark and light, thirteen colours, each a `light-dark()` in tokens.css: `bg` the page, `fg` text and the main
  filled button, `card` a fill (never a border), `tile` a block inside a sheet, `sheet` a bottom sheet, `paper` a draft
  or a quote, `muted` secondary text, `faint` small labels on the page, `line` hairlines between rows, `on` text on a
  filled button, and three that mean something: `flag` needs him, a deadline or a failure, `ai` an agent or a guess of
  Life's, `ok` it worked. Most of a screen is black and cream (dark `bg` `#07080a`, `fg` `#fff8ea`; light `bg`
  `#f3f4f5`, `fg` `#0d0e11`). Never a hex in a screen; the values are tokens.css's.
- **Type.** Manrope only: thin (250) for a title, bold (650) for what matters, 15 px body, small labels in capitals (11 px,
  600, 0.22em apart). Web pages load it from Google Fonts through tokens.css; mail loads no web font, so it shows
  Manrope only where installed. The phone bundles Manrope.
- **Hierarchy.** Size and weight carry it, not colour: one filled button for the primary action, the others quiet.
- **Shape.** Controls 12 px radius, panels 22 px, buttons full pills in the app, icon strokes 1.5 px, spacing 8, 16, 24,
  48. No paper texture, gradients or decorative shadows.
- **Cards have no border** (owner, 30 Oct 2026): a card, a panel, an option or a field stands out from the page by
  its `card` fill only, and a field inside a card takes the page's `bg` (owner, 31 Oct 2026); a chosen one is filled (`fg`). A rule line separates rows
  of a list, never draws a box.
- **Parked (30 Oct 2026).** The Mac app's UI keeps its old layout and fonts, with the colours above; Android keeps the
  old look (`Brand.kt`, lifelog's `docs/design.md`).

## The mark

- **Wordmark.** "Life" in Cormorant Garamond Bold, only the L italic, outlined as one drawing:
  [`assets/brand/life.svg`](../assets/brand/life.svg) (the guide's L and its Cormorant "ife", set as the guide sets
  them). No surface sets it as text, so Cormorant ships nowhere. Leave one x-height clear around it.
- **Icon.** The white L on ink, a rounded square with 22% corners: [`assets/icon/icon.svg`](../assets/icon/icon.svg)
  (the README's, `/icon.svg`, rendered to `icon-512.png`), and `app.svg`, the same on macOS's icon grid.
  `scripts/app.ts` renders `app.svg` into `Life.icns`, and `life-l.svg` (the L alone, the menu bar's) and `life.svg`
  (the `Wordmark` view's) into template PDFs. The iPhone's icon (`AppIcon.icon`) is the same L, cream on ink in every
  appearance.

## Principles

Give the words room. Keep the source close: show where a memory came from. Make colour useful: status only.

Fonts are under the SIL Open Font License. Web pages load Manrope from Google Fonts, through
`tokens.css`; the parked Mac app still bundles its old fonts in `apps/mac/Fonts`.
