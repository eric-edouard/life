import LifeConnector
import SwiftUI

/// The Projects tab (nav v3): the projects underway (`ProjectsList`), then his areas, parked and done projects; one of
/// them opens its page behind a header (`ProjectHead`) above its matters; Ask Life's cut of the matters keeps its own
/// list. Life gives the projects, their order and counts, and each one's list (`read_projects`, `read_matters`); the
/// phone only groups them as Life's status says.
struct ProjectsScreen: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    @State private var visibility = NavigationSplitViewVisibility.all
    /// What he typed on the asks pushed on a matter: here, above both columns, so a fold keeps it.
    @State private var notes = CardNotes()
    /// What he typed on a project's question (`AppRouter.projectAsk`).
    @State private var askNotes = CardNotes()
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// A compact width opens a matter out of its row and closes it back into it; beside the list nothing is pushed, so
    /// nothing zooms. Set at every width, so a fold never changes what the detail column is (a draft on the page stays).
    @Namespace private var matterZoom

    /// Two columns, the list and a matter or a project's Details: side by side on a regular width, one at a time on a
    /// compact one.
    var body: some View {
        @Bindable var router = router
        let chip = chosen
        NavigationSplitView(columnVisibility: $visibility, preferredCompactColumn: $router.matterColumn) {
            // Beside the agents' page the list is the agents, else the projects or their rows.
            if isAgentsBeside {
                AgentsScreen(isBeside: true)
            } else {
                // The list of projects, or a project's header and its rows: each shows its own read, so one failing
                // leaves the others.
                content(chip)
                    .background(Palette.bg)
                    // A swipe's mark and a project's status, said back with Undo.
                    .saysBack()
                    .screenTitle(chip?.name ?? "Projects", state: header)
                    // A project's page goes back to the list; beside a matter, the Pendant is the matter column's.
                    .shellBar("", hasPendant: sizeClass != .regular, onBack: backToList)
                    // The page's list and header, again after an answer on a matter (and once Life's read names the project
                    // chosen). The projects list is its own read.
                    .task(id: [chip?.identity ?? "", isProjectsList ? "list" : "cut", answersKey]) {
                        await refresh(chip)
                    }
            }
        } detail: {
            detail
        }
        // Side by side on a regular width wide enough (the iPhone Duo open wide). Open upright (669 pt) UIKit overlays the
        // list on the matter, whatever the column widths: kept on purpose (the owner's call, 19 Nov 2026); the system's
        // sidebar button brings the list back.
        .navigationSplitViewStyle(.balanced)
        // The split view can drop the selection when it expands: a regular width always shows a page.
        .onChange(of: sizeClass, initial: true) { fillSelection() }
        .onChange(of: list(of: chosen).value) { fillSelection() }
        .onChange(of: router.detail) { fillSelection() }
        // An agent named from elsewhere is the one on show beside the agents, not a page pushed over it.
        .onChange(of: router.matterPath) { _, path in
            guard isAgentsBeside, case .agent(let id)? = path.last else { return }
            router.agentShown = id
            router.matterPath = []
        }
        // Here, above both columns, so a fold that collapses the matter's page keeps the sheet and its running start.
        .sheet(item: matterSheetBinding) { sheet in
            switch sheet {
            case .agent(let id, let agent): AgentSheet(matter: id, agentID: agent)
            case .icon(let id): MatterIconSheet(matter: id)
            case .start(let id):
                if let matter = life.matter[id]?.value {
                    StartAgentSheet(matter: matter)
                }
            }
        }
        // His answer closes it where he was; the result he read is forgotten, so the next opens on its question.
        .sheet(item: $router.projectAsk, onDismiss: forgetAskResult) { ask in
            ProjectAsk(ask: ask, notes: $askNotes) { router.projectAsk = nil }
        }
    }

    /// The agents are the list, and the agent on show the page beside them (a regular width).
    private var isAgentsBeside: Bool { sizeClass == .regular && router.detail == .agents }

    private var shownAgent: String {
        router.agentShown ?? life.agents.value?.agents.first { !$0.isOver }?.id ?? ""
    }

    @ViewBuilder private var detail: some View {
        @Bindable var router = router
        switch router.detail {
        case .project(let id)?:
            stack { ProjectDetails(id: id).id(id) }
        case .matter(let id)?:
            stack { MatterThreadPage(id: id).id(id) }
                .zooms(from: id, in: matterZoom)
        case .agents? where isAgentsBeside:
            stack { AgentPage(id: shownAgent).id(shownAgent) }
        case .agents?:
            stack { AgentsScreen() }
        case .spending?:
            stack { SpendingPage() }
        case nil:
            Notice(title: "No matter chosen.", detail: "Pick one from the list.").background(Palette.bg)
                // Loading, unreachable, no matters: the top group stays.
                .shellBar("")
        }
    }

    /// The detail column's page and what is pushed on it (`AppRouter.MatterRoute`). Back to the page, by his Done or the
    /// system's back: the result he read is forgotten, so the next ask opens on its own question.
    private func stack(@ViewBuilder _ root: () -> some View) -> some View {
        @Bindable var router = router
        return NavigationStack(path: $router.matterPath) {
            root().navigationDestination(for: AppRouter.MatterRoute.self) { route in
                switch route {
                case .card(let ref, let matter):
                    CardPage(
                        ref: ref, source: life.asks(ofMatter: matter), notes: $notes,
                        leave: { router.matterPath = [] }
                    )
                    // A pushed screen: Back, then the Pendant.
                    .shellBar("")
                case .agent(let id): AgentPage(id: id)
                case .matter(let id): MatterThreadPage(id: id)
                case .session(let id): AgentSessionPage(id: id)
                }
            }
        }
        .onChange(of: router.matterPath) { _, path in
            guard path.isEmpty, let taken = notes.taken else { return }
            life.forget(taken.key)
            notes.taken = nil
        }
    }

    /// The chip chosen, as Life lists it now; none is the Projects list (or a chip Life no longer lists).
    private var chosen: ProjectChips.Chip? {
        life.projects.shown().onScreen?.chips.first { $0.identity == router.chip }
    }

    /// The title's count: on Ask Life's cut, how many of the matters' rows it keeps ("3 of 7"); on a project's page, its
    /// matters; on the list, the projects underway.
    private var header: String? {
        if let cut = router.cut(of: .matters) {
            return life.matters.shown().onScreen.map {
                "\(cut.cut($0.matters, ref: \.id).count) of \($0.matters.count)"
            }
        }
        guard let chip = chosen else { return life.projects.shown().onScreen.map { "\($0.underway) underway" } }
        return chip.matters == 1 ? "1 matter" : "\(chip.matters) matters"
    }

    /// The projects and areas themselves: no chip chosen and nothing Ask Life cut.
    private var isProjectsList: Bool { chosen == nil && router.cut(of: .matters) == nil }

    /// Back from a project's or an area's page to the list of projects; the list is where he already is.
    private var backToList: (() -> Void)? {
        guard chosen != nil else { return nil }
        return { router.chip = nil }
    }

    /// What an answer on a matter changes here: its page and its header read themselves again.
    private var answersKey: String { "\(life.answersEnded.values.reduce(0, +))" }

    /// The read under a chip: with none, every running matter.
    private func list(of chip: ProjectChips.Chip?) -> ReadState<MatterList> {
        chip.map { life.scopedMatters[$0.identity] ?? ReadState() } ?? life.matters
    }

    private func refresh(_ chip: ProjectChips.Chip?) async {
        guard let chip else {
            if isProjectsList { return await life.refreshProjects() }
            return await life.refreshMatters()
        }
        async let rows: Void = life.refreshScopedMatters(chip.kind, chip.id)
        async let head: Void = chip.kind == .project ? life.refreshProjectHead(chip.id) : ()
        _ = await (rows, head)
    }

    /// Closing the start sheet clears the start it showed, so the next opens on the form.
    private var matterSheetBinding: Binding<AppRouter.MatterSheet?> {
        Binding(
            get: { router.matterSheet },
            set: { sheet in
                if sheet == nil, case .start(let id) = router.matterSheet { life.forget(.start(matter: id)) }
                router.matterSheet = sheet
            })
    }

    private func forgetAskResult() {
        guard let taken = askNotes.taken else { return }
        life.forget(taken.key)
        askNotes.taken = nil
    }

    /// A regular width always shows a page: a page that is not a matter (Details, the agents, Spending) stays; a matter no
    /// longer in the chip's list gives way to its first.
    private func fillSelection() {
        // The projects list chooses no matter.
        guard sizeClass == .regular, !isProjectsList else { return }
        // A page that is not a matter, or a matter he opened from elsewhere, stays whatever the chip's list holds.
        if router.detail != nil, router.matter == nil { return }
        if router.isMatterFromElsewhere { return }
        let matters = list(of: chosen).value?.matters
        let isGone = router.matter == nil || matters?.contains { $0.id == router.matter } == false
        router.select(matter: isGone ? matters?.first?.id : router.matter)
    }

    /// The projects list, or a project's or area's page: its header, then its rows as their read stands.
    @ViewBuilder private func content(_ chip: ProjectChips.Chip?) -> some View {
        if isProjectsList {
            ProjectsList()
        } else {
            page(chip)
        }
    }

    private func page(_ chip: ProjectChips.Chip?) -> some View {
        let shown = list(of: chip).shown()
        let cut = router.cut(of: .matters)
        // Ask Life's cut is of the Projects list: Life's rows, the ones it named, in its order.
        let matters = shown.onScreen.map { list in cut.map { $0.cut(list.matters, ref: \.id) } ?? list.matters }
        return List {
            // Its toast stands at the top until his X.
            if cut != nil { CutToast(kind: .matters).quietListRow() }
            if let chip, chip.kind == .project {
                ProjectHead(id: chip.id) { router.projectAsk = OpenAsk(ask: $0) }.readingWidth().quietListRow()
            }
            if let matters {
                // A cut is Life's order: no "Parked" part, as on a chip.
                rows(matters, chip: chip, isCut: cut != nil)
            } else {
                ReadScreen(
                    shown: shown, retry: { await refresh(chip) },
                    loading: { RowsPlaceholder(label: "Loading the matters") },
                    empty: { EmptyView() }, content: { _ in EmptyView() }
                )
                .quietListRow()
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden)
        .safeAreaPadding(.bottom, Metrics.Spacing.xl)
        .syncMark(life.syncMark(shown, stamp: list(of: chip).stamp, tellsAgents: false), retry: { await refresh(chip) })
        .motion(Motion.standard, value: matters?.map(\.id))
        .motion(Motion.standard, value: cut)
        .scrollDismissesKeyboard(.interactively)
    }

    /// The rows in Life's order (his marked ones first); on the matters' list, a parked or done project's matters last,
    /// under "Parked". A swipe to the right marks one, or unmarks it: the system's own swipe action, as Mail flags a message.
    @ViewBuilder private func rows(_ rows: [MatterRow], chip: ProjectChips.Chip?, isCut: Bool) -> some View {
        let parkedFrom = chip == nil && !isCut ? rows.firstIndex(where: \.isParked) : nil
        let split = parkedFrom ?? rows.count
        if rows.isEmpty {
            Text("Nothing is running here.").font(.body15).foregroundStyle(Palette.muted)
                .padding(Metrics.gutter).quietListRow()
        }
        ForEach(Array(rows.enumerated()), id: \.element.id) { at, row in
            let isMarked = life.isImportant(row.id, as: row.important)
            let isParked = at >= split
            VStack(alignment: .leading, spacing: 0) {
                if at == parkedFrom { ListLabel("Parked") }
                Button {
                    router.matterPath = []
                    router.select(matter: row.id)
                } label: {
                    MatterRowView(row: row, isMarked: isMarked)
                }
                .buttonStyle(
                    .groupedRow(
                        at: isParked ? at - split : at, of: isParked ? rows.count - split : split,
                        isChosen: sizeClass == .regular && router.matter == row.id)
                )
                .zoomSource(row.id, in: matterZoom)
            }
            .readingWidth()
            .appears()
            .quietListRow()
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button(isMarked ? "Unmark" : "Important", systemImage: isMarked ? "flag" : "flag.fill") {
                    Task { await life.setImportant(row.id, !isMarked) }
                }
                .tint(Color.pick)
                .offWhileOutOfReach()
            }
        }
    }

}

/// A project's question, opened from its header.
struct OpenAsk: Identifiable {
    let ask: ProjectHeader.Head.Ask
    var id: String { ask.ref }
}

extension View {
    /// A list row with nothing of the list's own: no inset, separator or fill, so it draws as a row of a stack.
    func quietListRow() -> some View {
        listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
    }
}

struct MatterRowView: View {
    let row: MatterRow
    @Environment(LifeStore.self) private var life
    /// His mark, his tap first (`LifeStore.isImportant`).
    let isMarked: Bool

    var body: some View {
        let parked = row.isParked
        let agent = row.agent.flatMap { id in life.agents.value?.agents.first { $0.id == id } }
        return Row(
            title: row.name, icon: row.symbol,
            iconTint: Palette.muted, detail: row.nextStep?.text, isMarked: isMarked, isInList: true
        ) {
            // A parked project's matter waits: no dot, no agent.
            if parked {
                EmptyView()
            } else if row.needsYou == true {
                StateDot(color: Palette.flag)
            } else if agent?.status == .running {
                Spinner(size: .small).foregroundStyle(Palette.ai).accessibilityLabel("An agent is working")
            } else if row.agent != nil {
                // Idle until something new touches the matter: its mark, still, never the working spinner.
                Image(symbol: (agent?.runtimeName ?? .unknown).mark).font(.small)
                    .foregroundStyle(Palette.muted).accessibilityLabel("An agent is waiting")
            }
        }
        .opacity(parked ? 0.45 : 1)
        .motion(Motion.standard, value: isMarked)
        .accessibilityElement(children: .combine)
        // The dot and the flag have their words: the combined row would drop a hidden glyph's label.
        .accessibilityValue(
            [
                isMarked ? "Important" : nil, row.needsYou == true && !parked ? "Needs you" : nil,
                parked ? "Parked" : nil,
            ]
            .compactMap(\.self).joined(separator: ", "))
    }
}
