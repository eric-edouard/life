---
paths:
  - "apps/lifelog/apps/ios/**"
  - "apps/mac/**"
  - "apps/design/**"
  - "docs/design/**"
  - "apps/server/src/host/report*.ts"
  - "apps/server/src/host/nightly*.ts"
  - "assets/brand/**"
---

# What he sees: product, brand, designs

Moved from the root `AGENTS.md`, whose "Anything a person sees" section sends every design or UI change to `docs/design/sources-of-truth.md` first.

- **Nightly emails include every row.** Never cap a list or write "+N more"; the one kind left out on purpose is the ending check, never asked in the email (his word of 16 Nov 2026: "is this done?" is load) (`docs/operations.md`, "The nightly
  report").

- **Everything Life shows follows Life's own brand** (`docs/brand.md`): one source, `assets/brand/tokens.css`, which
  wins over any global brand skill for Life. A brand change lands there first; the email and the app copy it
  (`scripts/brand.test.ts` checks).

- **Designs live in the repo only** (his rule of 27 Nov 2026): every design, prototype and exploration is a dated file under
  `docs/design/`, listed in `docs/design/README.md` (its sections are the designs app's tabs). He views them at
  https://designs.ericedouard.com: the designs app (`apps/design`), served by the Mac from `~/Work/life`, which
  fast-forwards to `origin/main` every minute, so a merged design is live within a minute. Give him that link, at the
  design's path (`https://designs.ericedouard.com/#/<path under docs/design>`). Never a claude.ai artifact or any other copy.
- An iPhone app change can't land if a row green on the Mac's last parity board stops matching: the check's parity gate
  (`bun run parity --gate`, after the Swift builds) runs those rows' flows (`docs/handoff/2026-11-27-app-parity.md`).

- **Done means ran live** (his yes of 26 Nov 2026): a change to what he sees (the iPhone app, Ask Life's answers, cards) is done only after it ran on his real Life: the real ask through the main session, no `block.miss` in the log, its blocks drawn, and an app screenshot compared element by element with `docs/design/2026-11-23-chat-first/2026-11-25-app-v4.html`; the PR says what was checked and links the screenshots.
