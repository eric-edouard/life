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
| The iPhone app, widgets and Watch | `Palette` in `apps/lifelog/apps/ios/Shared/Palette.swift`: the thirteen colours, dark and light, copied, `tint`, `glass`, `wash` and the aura's ten; the app is dark only for now |

No other file writes a colour: the test also fails on a hex colour anywhere else in `apps/server/src`, `assets`, `apps/mac/Sources` or the iPhone app's `Shared`.

- **The look is the app's** (owner's yes, 18 Nov 2026: the new app's look becomes Life's brand, replacing the grey
  one). Dark and light, thirteen colours, each a `light-dark()` in tokens.css: `bg` the page, `fg` text and the main
  filled button, `card` a fill (never a border), `tile` a block inside a sheet, `sheet` a bottom sheet, `paper` a draft
  or a quote, `muted` secondary text, `faint` small labels on the page, `line` hairlines between rows, `on` text on a
  filled button, and three that mean something: `flag` needs him, a deadline or a failure, `ai` an agent or a guess of
  Life's, `ok` it worked (a vivid green: his ask of 20 Nov 2026, "a bit more vivid … to really describe success"). Most of a screen is black and cream (dark `bg` pure black `#000000`, `fg` `#fff8ea`; light `bg`
  `#f3f4f5`, `fg` `#0d0e11`). Never a hex in a screen; the values are tokens.css's.
- **Type** (owner, 26 Nov 2026). Manrope only, seven sizes and three weights (450, 600, 650), nothing else: 26 a
  profile's name, 19 an unfolded header, 16 a row's title, 15 body, 13.5 a row's line, 13 a section heading, 11.5
  meta (`--text-*` in tokens.css). Bold (650) for what the person reads or answers. A heading in a list is small
  (13 px, 600), muted, in sentence case: no capitals anywhere (owner, 19 Nov 2026). Web pages load it from Google Fonts
  through tokens.css; mail loads no web font, so it shows Manrope only where installed. The phone bundles Manrope.
- **Hierarchy.** Size and weight carry it, not colour: one filled button for the primary action, the others quiet.
- **Minimal** (owner, 23 Nov 2026: "minimalism is our brand"): a control shows a mark or a number, never a word
  label, wherever a mark or a number can say it (the waiting count, the pendant's dot, the microphone, Send). Words go
  to VoiceOver labels, not on screen. Where no mark says it, one quiet word on a pill is right ("Later": a clock
  confused, owner, 23 Nov 2026). Ease for anyone comes from fewer things on screen, not from labelled buttons.
- **Voice** (owner, 23 Nov 2026): a button that starts voice is always the microphone. The voice-bars glyph appears
  only while someone is speaking, and then it moves with the voice; it is never a static icon or a button.
- **Shape** (owner, 26 Nov 2026). Four radii: a button is a full pill; a small control 12 px; a block in the thread
  (option card, box, settings block) 18 px; a sheet or panel 22 px. Icon strokes 1.5 px, spacing 8, 16, 24, 48. No paper texture, gradients or decorative shadows.
- **Pure black, few cards** (owner, 22 Nov 2026): the dark page is `#000000` and a list is never wrapped in a card: its
  rows sit on the page, a `line` hairline between them. A card is kept only where a thing is a block of its own (a
  matter's goal, a field, a button), and then `card`, `tile` and `paper` are faint lifts of black (`#0b0c0e`, `#111214`,
  `#131416`), never a grey panel. Light is unchanged apart from lists.
- **Three more fills** (owner, 26 Nov 2026), cream at a strength so they sit on any ground: `tint` (10%, a quiet pill,
  his bubble), `glass` (14%, a floating control) and `wash` (5%, an unfolded item). Nothing else draws a grey; the
  phone takes tokens.css only, never a literal. The phone is dark only for now.
- **No borders** (owner, 30 Oct 2026 for cards; a hard rule for everything since 19 Nov 2026): no outline, ring or
  stroke around any surface or control. A card, a panel, an option or a field stands out from the page by its `card`
  fill only, and a field inside a card takes the page's `bg` (owner, 31 Oct 2026); a chosen one is filled (`fg`). A
  rule line separates rows of a list, never draws a box. Urgency is a `flag` dot and `flag` words, never a ring.
  His one exception (decision 82, 21 Nov 2026): every drafted part of a draft card (its bubble, reaction, file, mail block)
  wears a dashed outline, 1.5 px, that fades once it is sent.
- **The edge** (owner, 23 Nov 2026, built in v4): a ring round the screen on every screen, drawn stroke and glow, moving
  (two soft `fg` lights turning; faster while he speaks; Life's `ai` blue swell while it works; still when no Mac
  answers). It is the one exception to the no-borders, motion and colour rules, and it carries no words.
- **Motion exceptions** (owner, 26 Nov 2026), with the edge's aura as their home: the edge, the pendant breathing, the
  ink-in reveal of a redraft, the suggested asks turning, the thinking line's shimmer. A long task shows a still
  ring that fills at each milestone, never a spinner. Otherwise nothing moves by itself (Motion, below).
- **Colour exceptions** (owner, 26 Nov 2026): an app's own colours on its drafts (WhatsApp green, Messages blue), a
  face's hue, and the aura's ten colours (`--aura-*`), never red or bright green.
- **Emoji** in Life's interface are monotone. A reaction is one of the rating's three marks (👎 👍 🤩), plus 👀 for
  handed on work.
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
- The interface says "you": never the person's own name. Life may say "I" in its sentences ("I'm on it"); a button
  never does (owner, 26 Nov 2026). One exception, his ruling of 26 Nov 2026: the opening screen's greeting, "Hi" and
  the first name Life holds for him (`read_thread`'s `owner`).
- A button is the answer, in three words at most, and one word has one meaning everywhere ("Yes", "No", "Someone
  else…", "Skip", "Undo"). Words go only on an ask's and a question's answers, a confirm's two choices and a draft's
  quick-edit chips (Warmer, Shorter, In French); everything else is a mark, or "Later".
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
