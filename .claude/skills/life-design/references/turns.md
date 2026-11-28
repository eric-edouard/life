# Turn by turn

The thread on the phone is turn by turn: each of his asks with what Life answered is a thread turn (`docs/glossary.md`,
"thread turn").

- The rule: `docs/design/philosophy.md`, "The thread", the turn by turn line (28 Nov 2026). Read it; don't restate it.
- The real code: `ThreadTurns` (`apps/lifelog/apps/ios/Kit/Sources/LifeConnector/Thread/ThreadTurns.swift`, tested by
  `Kit/Tests/LifeConnectorTests/ThreadTurnsTests.swift`) and `ThreadView` (`apps/lifelog/apps/ios/Lifelog/Thread/ThreadView.swift`),
  drawn with `DesignSystem/ThreadComponents.swift`.
- The prototype it came from, for motion and scenes: `docs/design/2026-11-28-turn-by-turn-v3/turn.html` (header
  comment first) and its comparison page `index.html`; the shell (phone, edge, field, top controls): `shell.js`.
- What is still open: philosophy.md, "Open questions".
