# Projects tab on the phone (decision 95, drawn to decision 98)

Worktree: $HOME/Work/life-wt/projects-tab (branch projects-tab, off origin/main 780823299, which holds the server's read of projects, #922).
Spec: ~/Life/docs/product/app-design/projects-tab-2026-11-21.md, redesign-rules-2026-11-21.md; frames DuoFoldProjects, DuoFoldProjectsOne, DuoFoldProjectsAsk, DuoFoldProjectsMenu, DuoFoldProjectsParked, DuoFoldProjectsArea, DuoFoldProjectDetails (renders in ~/Life/docs/product/app-design/renders/).

## What changes

The second tab, Matters, becomes Projects (same glyph). Its list column:
1. Title "Projects · N underway" (`screenTitle`).
2. A row of chips that scrolls sideways (first row of the one scroll): All, then `read_projects`' chips in the server's order (projects, areas, parked projects dimmed). Each: icon (a project's area icon via `MatterIcons.areaSymbol(area)`, an area's own), name, the flag dot when `needYou > 0`, the spinner when `agentAtWork`. Chosen = filled. A chip filters in place; the chosen chip scrolls into view; re-tapping the Projects tab resets to All. Long press on a project chip: a context menu with Park, Mark done, Details (the existing `LifeStore.setStatus` write: `change_directory_entry` with `said`; said back with Undo by the existing toast).
3. A project chip's header (`read_project`): situation lines first, then "Status · for your goal: …" muted with a round info button (Details), the ask as one coral card ("Needs you · by Thu 18:00", question, matter name) that opens the card as a sheet (CardPage in a sheet with Close), the agents as slim rows (program mark from `read_registered_agents` by id, title, live line). None while parked (the server sends none).
4. The matters: All = `read_matters` (as today, the parked label section kept); a project chip = `read_matters {project}`; an area chip = `read_matters {area, noProject}`. One grouped inset card per list (`groupedRow`, 60 pt rows, pick fill on the open one), `ListLabel` for the Parked part.
5. Details (`DuoFoldProjectDetails`): shown in the split view's detail column (pushed over the list on a compact width): status as one `SegmentedChoice` (Underway, Parked, Done), the goal with "Your goal r of n", People (rows opening their page), Chats (rows, name only: the wire carries no link), Repos (name and folder). Grouped inset cards with `ListLabel`s.

The matter page's project link now opens the Projects tab on that project's chip (decision 95: "the filtered list is the project"), so the pushed project page goes.

## Debt plan
Tier: standard: adds a screen's parts and three reads on a sound foundation (the reads, models and writes exist; the screen and split view exist).
Inventory (rg 'MatterFilter|areasByCount|ProjectHead|SituationLine|refreshProject|ProjectPage|MatterRoute|\.project\(|readMatters\(project|fixtureTab|fixtureProject|Tab\.matters' apps/lifelog/apps/ios scripts apps/lifelog/fixtures/design):
- Kit/Sources/LifeConnector/Models/Project.swift:6,39 — `ProjectChips`, `ProjectHeader` (decoded, no reader yet); :79 uses `MatterList.ProjectHead.SituationLine`.
- Kit/Sources/LifeConnector/Models/Matter.swift:140-158 — `MatterList.ProjectHead` and `MatterList.project` (read_matters' project head, read today by ProjectPage only); :173-185 `shown(filter:)`, `areasByCount`; :188-201 `MatterFilter` (the filter menu, MattersScreen only).
- Kit/Sources/LifeConnector/LifeAPI.swift:94-96,149-152 — `readMatters()`, `readMatters(project:)`; no readProjects/readProject/area read.
- Kit/Sources/LifeConnector/Models/Party.swift:43-48 — `ParsedRead` conformances.
- Kit/Tests/LifeConnectorTests/ModelsTests.swift:148-181,282-314 — head and filter tests; LifeActionsTests.swift fake `LifeAPI`.
- Lifelog/Matters/MattersScreen.swift — the split view, the filter menu (filterBar, MatterFilter), the list, `MatterRowView`.
- Lifelog/Matters/ProjectPage.swift — the pushed project page (status control, goal, matters) from `read_matters {project}`.
- Lifelog/Matters/MatterPage.swift:129 — the project link pushes `.project`.
- Lifelog/Shell/AppRouter.swift:6,34-37,73-78 — `Tab.matters`, `MatterRoute.project`, `open(matter:)`.
- Lifelog/Life/LifeStore.swift:18,340-345,641-662,780 — `project` dict (read_matters project), `refreshProject`, `setStatus` (refreshes project + matters), pairing reset. The file is 815 lines.
- Lifelog/RootView.swift:38,139,146 — the tab, `-fixtureTab matters`, `-fixtureProject` pushes `.project`.
- Lifelog/Fixtures/LifeFixture.swift:172-181,532 — fixture `readMatters(project:)` and `projectRead` (design `read_matters_project.json`).
- apps/lifelog/fixtures/design/frames.json — DuoFoldProject, DuoFoldProjectParked (`-fixtureProject`), DuoFoldImportantFilter (filter menu), many `-fixtureTab matters`.
- scripts/design-system.test.ts CAPS "Matters/MattersScreen.swift".
- apps/lifelog/apps/ios/AGENTS.md — the Matters tab paragraph.
Shape:
- One source of truth per read, all on the server: chip order, counts, dots, spinner, list scope (`isInScope`), header agents and ask. The phone sorts and filters nothing; it picks the read by the chosen chip.
- LifeStore holds the three reads like its others (`load`, through `ReadFlights`, cached for a cold start): `projects: ReadState<ProjectChips>`, `projectHead: [id: ReadState<ProjectHeader>]`, and the existing `project` dict renamed `scopedMatters`, keyed by chip identity (`ProjectChips.Chip.identity`), holding the chip's `MatterList`. The chips join `refresh()`, `needsRetry` and `retryFirstReads()`; a new pairing empties all three. `setStatus` refreshes the chips, that head, its list and the matters; an answer refreshes the chips, and the screen reads its header and list again on `answersEnded` (as MatterPage does); his mark refreshes the scoped lists that hold the matter.
- The chosen chip and the detail column's one destination live in `AppRouter`: `detail: Detail?` (`.matter(id)` or `.project(id)`, Details), with `matter` read from it, so the column never has two pages (above the split view, so a fold and a matter's Back keep them; the matter page's project link sets the chip). On a regular width the automatic selection picks from the chosen chip's rows, not All's.
- The chips and the header stay on screen whatever the list holds: the list's empty state is a line inside the scroll, never a screen that replaces them.
- The ask: its sheet reads its matter (`refreshMatter`) and shows the card from `asks(ofMatter:)` once read, a placeholder while it loads, "Already answered" only once a read says so (no matter: the inbox's asks). `CardPage` loses its `shellBar`: the matter stack adds it at its destination, the sheet adds `CloseItem`.
- Details: Chats and Repos are shown, not opened: the wire gives a chat's key and a repo's name and Mac folder, nothing the phone can open. An issue asks the server for an openable link (a chat's deep link, a repo's web address); written in iOS AGENTS.md.
- MattersScreen is reshaped into the Projects screen (renamed file and type); ProjectPage is reshaped into ProjectDetails (renamed). The header is its own small view file. CardPage takes `isSheet` (Close instead of the Pendant) so the ask sheet reuses it.
- A chip is the design system's `FilterChip` (screens draw none of their own), moved out of Pieces.swift (1106 lines) into `DesignSystem/FilterChip.swift` and given an icon, the flag dot, the spinner and a dimmed state; `StartAgentSheet` keeps using it as before. (Drift found while building: the plan said a screen-local chip; the design-system test refuses a screen's hand-drawn capsule.)
- Kit adds one pure value, `ProjectChips.underway` (the title's count), with its test.
State:
- `AppRouter.chip: String?` (chip identity; nil = All), global, one per app; `AppRouter.detail: Detail?` replaces `matter: String?` as the detail column's one destination, global.
- `LifeStore.projects`, `LifeStore.projectHead[id]`, `LifeStore.project[chip identity]`: per read, owned by LifeStore.
- The ask sheet's `CardNotes` and which ask is open: screen state, as MattersScreen keeps for the matter's asks.
Deletes:
- `MatterFilter`, `MatterList.shown(filter:)`, `MatterList.areasByCount`, the filter menu and its test (chips replace it, decision 95).
- `MatterList.ProjectHead`, `MatterList.project` and their tests (the header is `read_project`); `SituationLine` moves into `ProjectHeader`.
- `AppRouter.MatterRoute.project` and the pushed ProjectPage (the project is its chip).
- Fixture's `projectRead` head building (replaced by `read_project` reads).
- LifeStore's `traceOf` (a pure function of an ended action) moves to its own file, `traceAction`, so the store, already 815 lines, shrinks instead of growing.
- frames.json: all seven new frames mapped (the menu's long press as `why`); DuoFoldProject, DuoFoldProjectParked and DuoFoldImportantFilter become `why` (their screens are replaced); `-fixtureProject` goes; `-fixtureTab matters` becomes `projects`.
Net lines: expected +520 / −330
Plan review: reshape, then fixed in the plan: (1) one detail destination (`Detail`), auto-selection from the chosen chip's rows, chips and header kept when the list is empty; (2) refreshes after an answer and a mark, chips in the retries, scoped reads cleared on a new pairing, all through `load`; (3) the ask resolved through its matter's read before the card shows, and `CardPage`'s bar moved to its hosts instead of an `isSheet` flag; (4) Chats and Repos shown without an open action until the wire carries a destination (issue opened), recorded in iOS AGENTS.md, all seven frames mapped; (5) inventory updated (the readers were already written in this worktree), cache named `scopedMatters`, the DEBUG move dropped. One divergence kept: `traceOf` moves out of LifeStore to honour the 800-line cap the brief asks to watch.
