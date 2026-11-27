# The waiting list against the prototype (26 Nov 2026)

The owner tapped the count on his iPhone (16:10, real data): "Is that normal that it looks so bad? Nothing is
formatted at all." This audits that list, element by element, against the approved prototype
(`2026-11-25-app-v4.html`: `waiting()`, `rowHTML`, `lineHTML`, `pageHTML`/`bodyHTML`/`barHTML`, the `M` asks, the
`wafix` fix ask) and `docs/product.md`. Where a lab pick (`2026-11-26-lab-decisions.md`) differs from the prototype,
the prototype is followed and the difference is listed at the end for him to settle.

Screens: `2026-11-26-screens-waiting-rows/` (`side-by-side.png`: prototype list, app list, prototype open payment, app open
"your move"; `list.png`, `open-fix.png`, `open-move.png` alone). Demo data shaped like his: scenario
`LifelogE2E/scenarios/W1.json` over `fixtures/wire/life/read_thread_waiting.json` (two signed-out networks, six guessed
people, two of his own steps).

## What he saw, what the prototype draws, what changed

| Element | His screen (before) | Prototype | Now |
|---|---|---|---|
| List shape | vertical rows for 8+ asks; 2 to 7 went sideways as full cards | one vertical list of rows (`.fc`, `rowHTML`) | always the vertical list; the sideways cards, scenario L1 and its fixture are deleted (his word: the sideways list was an exploration) |
| Row spacing | 4 pt between 44 pt rows (cramped) | 7 px above and below each row, 2 between | 12 pt between rows |
| Face, fix | generic file icon | the network's logo (`who:WA`) | the network's mark (`NetworkMark`) |
| Face, "Know who someone is" | generic file icon | a person's initial | the guess's initial (the person as their network shows them), else the person mark; initials upper case |
| Face, his own step | generic file icon | a mark by kind (`BANK`, an initial) | a tick mark |
| Title, fix | "LINE is signed out" | "Sign WhatsApp back in" | "Sign LINE back in" (server, `fix-checks.ts`) |
| Title, "Know who someone is" | "Know who someone is" (no name) | the ask in his words | the question: "Is this Kip?" |
| Title, his own step | the matter's name | the action ("Call the bank") | still the matter's name; the step's own sentence opens the page (see open items) |
| Sub line, who | empty for most rows | `sub`, who or what for ("Paul, for the leak") | the chat as the network shows it ("+66 …, WhatsApp", "kip.edits, Instagram"), else the matter it serves; a fix says "Messages stop reaching Life"; his step says "Your move" |
| Sub line, when | orange "today" on every Life ask | `when`, the due day; orange only when it is today | the deadline only ("today" orange, "tomorrow", a weekday this week, else "3 Dec"); none without one. Cause: a Life check's `at` is when the thread was read (`life-thread.ts`), and the row showed it |
| Later pill | on every row | only on a task (`m.task`: his own payment, his call) | only on his own step (`your move`) or a payment he makes (`Check.isTask`) |
| Open page, why | nothing: no why | `.why` under the header | the card's `context`, Markdown: the guess's quoted words and where they were said; his step's sentence first |
| Open page, answers | one wide "Later" (fix); on Life's guesses no main answer | one wide main answer, then the pills | the first answer is the wide one when the card names none (the contract: "the first is recommended") |
| Open page, fix | "Later" only, no way to sign in | why, the steps, "Done, it's linked", Later | why; Later. The sign-in button comes with the sign-in work (`docs/plans/2026-11-26-sign-in-from-phone.md`), drawn by its option: no placeholder needed |
| Order | fixes first, then by when read | fixes first (`ASKS.unshift`), then by urgency | unchanged here (the `ask-live` branch owns broken-first placement) |

## Still open

- **"since 11:02" on a fix**: the bridge's sign-out time is not on the wire.
- **His step's title**: the prototype names the action; the step's sentence is third person and long ("<his name> will
  run a Google Maps search…"), so the row keeps the matter's name. A short imperative step needs the matter
  directions' words, a prompt change (ask first).
- **The fix's steps** ("On your phone, open WhatsApp…"): come with the sign-in work.
- **A guess with no chat** ("Is this Ana?") has no sub line: nothing on the wire says where she was read but the
  context's citation.

## Lab picks that differ from the prototype (for him to settle)

- **Focused list, sideways (A)**: removed for the prototype's vertical rows, on his word today.
- **How an ask shows its matter: "No matter on an ask"**: the sub line falls back to the matter an ask serves when no
  chat says who ("Is this Madame Vexil? · Email the notary…"), as the prototype's `sub` says what for ("For you and
  Nora"). Say if the matter should go.
- **Your move: the original prototype**: followed, but see "His step's title" above.
