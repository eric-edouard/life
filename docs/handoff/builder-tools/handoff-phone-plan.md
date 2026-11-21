# Phone side of agent hand-off (decision 78)

Worktree: $HOME/Work/life-wt/matter-handoff-phone (branch matter-handoff-phone, off origin/main 57576fca9, which
holds the server side, PR #915). Design: ~/Life/docs/product/app-design/move-runtime-2026-11-20.md and gen/gen_move.py.

## What the phone shows

- **Matter page, agent row** (`Lifelog/Matters/MatterPage.swift`, `AgentRow`): the row names the holder (`read_matter`'s
  `holder`: its program's mark and `name`, "Halden house agent"; no holder: the agent's runtime as today), and under it
  "Moved from <movedFrom.name>" when set. When a move is possible the row is a system pull-down `Menu` (up-down
  chevrons): "Open <holder name>" (the agent sheet, as the row opens today) and either "Move back to <movedFrom.name>"
  (when `life.agents`, `read_registered_agents`, lists that agent and it is not over: after a matter move the old holder
  is no longer anchored on the matter, so the matter's own `agents` can't tell; the desk refuses a stale one with its
  reason) or "Move to <moveTo>" with the subtitle "A new agent, until
  it's done". `moveBlocked` set, or no holder: no move option, the row stays the plain button it is today.
  Choosing asks once, a system alert ("Move <matter> to Codex?" / "Move <matter> back to the <name>?", the frame's
  message, "Move" / "Cancel").
- **His receipt.** `hand_over` answers `asked` with the move's id (`move`, the ask's id) before the desk applies it.
  `AgentChangeResult` decodes `move`; the action's proof (`ActionBook`, already per pairing) is the receipt. The move
  shown is one Kit rule, `AgentMove.shown(receipt:read:refused:)`: the read's move with the receipt's id; else the
  receipt's ask in `read_registered_agents`' `refused` (a refusal before the desk wrote a move row: shape, no holder)
  as `failed` with its error; else, asked and not applied yet, as `notes`; with no receipt, the read's own move (one
  asked from another app shows too). The store reconciles after each read (`refreshMatter`, `refreshAgents`): the
  receipt's move done says the toast once and forgets the receipt; failed forgets it (a read's failed move stays shown
  for its hour; a refusal-only one is said as a flagged toast, since nothing else holds it).
- **While it moves** (only the row changes): `notes` (or asked): spinner and "Writing its notes…"; `starting`: spinner
  and "Starting on <runtime>…" (the holder is already the new agent); `done`: at rest, toast "<matter> moved to
  <runtime>" (ok glyph, no Undo); `failed`: the reason in `flag` above the row with a "Try again" `QuietChip` (the same
  move again); the tap's own call failing shows its reason there too, Try again only when `canTryAgain` (a call that
  may have gone is never sent blind: a second ask would be refused as under way and hide the first). While the shown
  move is under way the page reads the matter and the agents every 3 s (`.task(id:)`, ending with the page); on done
  the store reads the agents and the inbox again, so a card's mark follows its new holder (`read_inbox`'s `agent` is the
  holder already).
- **Agent sheet** (`Lifelog/Matters/AgentSheet.swift`): the head becomes the agent's mark and its name
  (`read_registered_agents`' `name`, matched by id in `life.agents`; else the runtime as today). Under it one row
  "Agent" whose value is a system pop-up `Menu`: "Claude Code" / "Codex" with their marks, the current checked; the
  other is left out when `moveBlocked` is set (then the value is plain text). Picking the other asks once ("Switch the
  <name> to Codex?", "It writes its notes on each of its matters, then starts fresh on Codex. Its cards stay open.":
  no count, the phone does not know the desk's open assignments). The switch shown is the same `AgentMove.shown` over
  the agent's `switch`, with its receipt. Under way: the spinner and "Writing notes, n of N…" (the desk's `done`/`total`)
  then "Starting on Codex…" (the sheet reads the agents every 3 s meanwhile); done: the value and the head's mark follow
  the new runtime, toast "The <name> is on Codex", and the matter pages showing it read again; failed: the reason in
  `flag` under the row, with "Try again". The sheet opens the holder (`matter.agents` by `holder.id`, else the first).
- **Not built:** `DuoFoldAgentsListMoved` (the app has no Agents list yet); the card pill's agent short name (the
  agents-names design, every card, not this move: the pill's mark already follows the holder). No frames.json entries
  and no fixture phases: none of the move frames is in frame-map.json (no renders yet), and screen review is deferred.

## Kit (pure, tested)

- `Models/AgentMove.swift` (new): `MovePhase` (`notes, starting, done, failed`, `UnknownTolerant`, `isUnderWay`),
  `AgentMove` (`id, phase, reason?, done?, total?`: a matter move's `move` and a runtime switch's `switch`, one shape)
  with `shown(receipt:read:refused:)`, the one rule above; `NamedAgent` (`id, name, short?, runtime`: one identity
  shape) and `MatterHolder` (a `NamedAgent` plus `movedFrom: NamedAgent?`); `MoveBlocked` (`runtime, reason`);
  `RegisteredAgents.Refusal` (`ask, agent?, error`, its `refused`); `Matter.moveChoice(among:)` (`.runtime(RuntimeName)`
  or `.back(agent:name:)`, nil with no holder or `moveBlocked`) and `MoveWords` (the menu, alert, row line, toast and
  switch sentences, one place).
- `Matter` decodes `holder`, `moveTo`, `moveBlocked`, `move`; `RegisteredAgent` decodes `name`, `short`, `switch`,
  `moveTo`, `moveBlocked` (all optional: older servers and `read_matter`'s `agents` lack them).
- `AgentRequest.Action` gains `handOver = "hand_over"`; `LifeActions.changeAgent` takes `asked` as success (a move
  answers at once; its phase is read).
- `ContractTests.lifesEnumsAreTheServers` mirrors `MovePhase` against `host/move-read.ts`' `phase: "…" as const`.
- Tests: `AgentMoveTests` (decoding a matter with holder/movedFrom/move and an agent with switch and `refused`,
  `moveChoice` in its four cases, `shown` in its four cases), `LifeActionsTests` (asked is success), `ContractTests`.

## App

- `LifeStore`: `ActionKey.move(String)` (a matter move by its matter's id, a runtime switch by its agent's); `SaidBack`
  gains `isDone` (a result with no Undo, drawn with the ok glyph; today a toast without Undo is always a failure);
  `refreshMatter` / `refreshAgents` reconcile the receipt as above. The agent actions (start, stop, resume and the
  two new moves) move to `Lifelog/Life/LifeStore+Agents.swift` (an extension; `perform` and `runner` lose `private`),
  so LifeStore.swift (815 lines today) ends under 800.
- `AgentLabel` (`DesignSystem/AgentMark.swift`) takes the agent's name (its runtime's when none is read): both callers
  name the agent, never the program, as the design says.

## Debt plan
Tier: standard: adds types (MovePhase, AgentMove, NamedAgent, MatterHolder, MoveChoice, MoveWords) on a sound foundation
(the wire is decided server-side; the phone reads phases and reconciles one receipt). The first review asked hard for the
ordering; kept standard as set by the builder: the ordering is one pure Kit rule with its tests, and no queue or retry
of the phone's own (Try again only on `canTryAgain`).
Inventory: `rg -n "holder|moveTo|moveBlocked|hand_over|handOver" apps/lifelog/apps/ios --glob '*.swift'` finds nothing;
`AgentChangeResult.State.asked` (Kit/Sources/LifeConnector/Models/AgentChangeResult.swift:8) exists; agent row
MatterPage.swift:345-368 (`AgentRow`), agent sheet head AgentSheet.swift:37-42, `AgentLabel` AgentMark.swift:32 (two
callers), `AgentRequest` LifeAPI.swift:39, `LifeActions.changeAgent` LifeActions.swift:172, LifeStore agent actions
LifeStore.swift:543-565, `SaidBack` LifeStore.swift:48 and its toast Pieces.swift:221-241, enum mirror
ContractTests.swift:101; the card's mark `Check.askingRuntime` Check.swift:496 (unchanged: `agent` is the holder on the wire).
Shape: Life decides every phase and reason (`host/move-read.ts`); Kit holds the one reading of them (choice, words,
transition), the views only draw. A matter move and a runtime switch share one phase type and one shape.
State: the receipt is the `.move(id)` action's proof (per matter or agent, per pairing: `ActionBook`), forgotten once
the reads show it ended; the 3 s re-read is the view's `.task(id:)` while the shown move is under way (ends with the
page or sheet); everything else is the latest read's.
Deletes: none beyond the agent actions leaving LifeStore.swift for their own file (moved, not duplicated).
Net lines: expected +420 / −60 (Kit ~+170 with tests ~+110, app ~+250).
Plan review: reshape, round 1 (Codex). Changed: a receipt (`move` id) with `AgentMove.shown` over reads and
`refused` replaces the read-only transition check (findings 5, 6, 7); "Move back" eligibility from `life.agents`, the
sheet opens the holder (1); no matter count in the switch ask (3); one identity shape `NamedAgent` (10); glossary names
in docs (8). Kept: the pill's short name and fixture phases are out (2, 9: see Not built); "back" vs "to" is chosen on
the phone from the wire's `movedFrom` and `moveTo` (4: the desk has no field for the back target; it refuses a stale one
with its reason, shown).
