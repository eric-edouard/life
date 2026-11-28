# Turn by turn

The app's direction (owner, 27 Nov 2026): each turn, his words and Life's answer, is a page.

## The sources

- The prototype and its comparison page: `docs/design/2026-11-28-turn-by-turn-v3/turn.html` (header comment first,
  then the scene you need) and `index.html`. Its shell (phone, edge, field, top controls): `shell.js`, `shell.css`.
- The pager: `turn.html`, the `.a-pager` and `.a-pg` rules and `pager()`; its variations (`V.pager`: snap, depth,
  peek).
- What is decided and what is open: philosophy.md, "The strategy", the 27 and 28 Nov log, "Open questions".

## The page rules in force (owner, 28 Nov 2026)

- His question is pinned at the top of its page under a soft blur, clamped to 2 lines; its type size steps down as it
  gets longer.
- The answer flows under it; a short answer sits centred.
- Earlier turns: pull down; each page snaps gently into place, one turn a page, opening on the latest.
- An answer comes whole and at once; Life working shows one step line until it does.
- Kept from variation A as it was: idle, typing, hold to talk, Life works, the slow ask, the failed read, and "Hey
  Life" replaced in place.
- App v4 stays the approved build target until he picks a drawn turn by turn.
