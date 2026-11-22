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
  Life's, `ok` it worked (a vivid green: his ask of 20 Nov 2026, "a bit more vivid … to really describe success"). Most of a screen is black and cream (dark `bg` pure black `#000000`, `fg` `#fff8ea`; light `bg`
  `#f3f4f5`, `fg` `#0d0e11`). Never a hex in a screen; the values are tokens.css's.
- **Type.** Manrope only. Bold (650) for what the person reads or answers, which is the largest text on the screen;
  thin (250) only for a single state word ("Sent.", "Recording."); 15 px body. A heading in a list is small (13 px,
  600), muted, in sentence case: no capitals anywhere (owner, 19 Nov 2026). Web pages load it from Google Fonts
  through tokens.css; mail loads no web font, so it shows Manrope only where installed. The phone bundles Manrope.
- **Hierarchy.** Size and weight carry it, not colour: one filled button for the primary action, the others quiet.
- **Shape.** Controls 12 px radius, panels 22 px, buttons full pills in the app, icon strokes 1.5 px, spacing 8, 16, 24,
  48. No paper texture, gradients or decorative shadows.
- **Pure black, few cards** (owner, 22 Nov 2026): the dark page is `#000000` and a list is never wrapped in a card: its
  rows sit on the page, a `line` hairline between them. A card is kept only where a thing is a block of its own (a
  matter's goal, a field, a button), and then `card`, `tile` and `paper` are faint lifts of black (`#0b0c0e`, `#111214`,
  `#131416`), never a grey panel. Light is unchanged apart from lists.
- **No borders** (owner, 30 Oct 2026 for cards; a hard rule for everything since 19 Nov 2026): no outline, ring or
  stroke around any surface or control. A card, a panel, an option or a field stands out from the page by its `card`
  fill only, and a field inside a card takes the page's `bg` (owner, 31 Oct 2026); a chosen one is filled (`fg`). A
  rule line separates rows of a list, never draws a box. Urgency is a `flag` dot and `flag` words, never a ring.
  His one exception (decision 82, 21 Nov 2026): every drafted part of a draft card (its bubble, reaction, file, mail block)
  wears a dashed outline, 1.5 px, that fades once it is sent.
- **Parked (30 Oct 2026).** The Mac app's UI is the exception to the type, shape and wording rules of this page until
  it is unparked: it keeps its old layout, fonts, capital labels and strokes (`Brand.swift`), with the colours above.
  Android keeps the old look (`Brand.kt`, lifelog's `docs/design.md`).
- **Not yet in code (19 Nov 2026).** Three surfaces predate the rules of 19 Nov, and each follows with its next
  change: the phone's capital labels; the pairing page's outlined button and thin title (`oauth.ts`); and the text of
  the asks the server writes, which predates the wording below.

## Wording

Every word Life shows follows these: a card's text, an agent's question, the app's labels, a push, a mail's subject.
Removing the person's load comes first (owner, 19 Nov 2026): a word, a label, a number or a control that could go
without the person answering slower or worse goes.

- The first line is the question, and it ends with "?". No category title above it.
- Show the thing, not a description of it: a person is their picture, their name as the network shows it and their
  number; a message is the message, with who and when ("Idris, WhatsApp, 14 Sep").
- Life does not talk about itself: no "Life thinks", no label naming it. A name shows only when someone else asks
  (an agent).
- The interface says "you": never the person's own name, never "I".
- A button is the answer, in three words at most, and one word has one meaning everywhere ("Yes", "No", "Someone
  else…", "Skip", "Undo").
- Every question can be left for the next one.
- No number the person cannot act on: no percentage of confidence, no count of facts, no "1 of 282". A deadline, an
  amount and a time pass.
- A thing is said once across title, question and button.
- The default is never described, unless it costs something at a known time.
- None of the system's own words in what the person reads: fact, guess, handle, step, turn, desk, episode, card.
- A name is four words at most. With no name the question is "Who is this?", and the description is one answer.
- What opens says what is behind it.
- A result is one word and one line, and the next thing comes by itself. Only what leaves the device (a send, a
  start) shows its checks.
- A state shows only when it is wrong or not known. Nothing says that all is well.

## Motion

Nothing jumps (owner, 19 Nov 2026). A state change, a new element and a shift of layout are animated. A thing that
changes state stays the same thing: a button becomes its busy state, then its result. A new element enters from where
it comes and leaves the way it came, and what sits below something that grows or shrinks slides. Motion answers a
tap; by itself only the recording dot, a spinner and a countdown move. It takes 0.2 s to leave, 0.3 s to change and
0.35 s to enter, and under Reduce Motion the same steps cross-fade without movement.

## The mark

- **Wordmark.** "Life" in Cormorant Garamond Bold, only the L italic, outlined as one drawing:
  [`assets/brand/life.svg`](../assets/brand/life.svg) (the guide's L and its Cormorant "ife", set as the guide sets
  them). No surface sets it as text, so Cormorant ships nowhere. Leave one x-height clear around it.
- **Icon.** The white L on ink, a rounded square with 22% corners: [`assets/icon/icon.svg`](../assets/icon/icon.svg)
  (the README's, `/icon.svg`, rendered to `icon-512.png`), and `app.svg`, the same on macOS's icon grid.
  `scripts/app.ts` renders `app.svg` into `Life.icns`, and `life-l.svg` (the L alone, the menu bar's) and `life.svg`
  (the `Wordmark` view's) into template PDFs. The iPhone's icon (`AppIcon.icon`) is the same L, cream on ink in every
  appearance (owner, 19 Nov 2026).

## Principles

Give the words room. Keep the source close: show where a memory came from. Make colour useful: status only.

Fonts are under the SIL Open Font License. Web pages load Manrope from Google Fonts, through
`tokens.css`; the parked Mac app still bundles its old fonts in `apps/mac/Fonts`.
