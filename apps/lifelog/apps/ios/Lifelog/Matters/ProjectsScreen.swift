import LifeConnector
import SwiftUI

/// The Projects tab (decision 95): every running matter ranked, under a row of chips that filters it in place by project
/// or area; a project's chip shows its header (`ProjectHead`) above its matters. The chips, their order and counts, and
/// each chip's list are Life's (`read_projects`, `read_matters`): the phone sorts and filters nothing.
struct ProjectsScreen: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    @State private var visibility = NavigationSplitViewVisibility.all
    @State private var isRetrying = false
    /// The last Retry failed too: said beside it, so a second failure is not the same as no tap.
    @State private var hasRetryFailed = false
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
            // Beside the agents' page the list is the agents, else the chips and their rows.
            if isAgentsBeside {
                AgentsScreen(isBeside: true)
            } else {
                // The chips, a project's header and its rows each show their own read: one failing leaves the others.
                content(chip)
                    .background(Palette.bg)
                    // A swipe's mark and a project's status, said back with Undo.
                    .saysBack()
                    .screenTitle("Projects", state: header)
                    // Beside a matter, the Pendant is the matter column's.
                    .shellBar("", hasPendant: sizeClass != .regular)
                    // The chosen chip's list and header, again after an answer on a matter (and once Life's chips name the chip
                    // chosen). All's list is the matters' read, which that answer reads again itself.
                    .task(id: [chip?.identity ?? "", chip == nil ? "" : "\(life.answersEnded.values.reduce(0, +))"]) {
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

    /// The chip chosen, as Life lists it now; none is All (or a chip Life no longer lists).
    private var chosen: ProjectChips.Chip? {
        life.projects.shown().onScreen?.chips.first { $0.identity == router.chip }
    }

    /// The title's count: on Ask Life's cut, how many of All's rows it keeps ("3 of 7"), else the projects underway.
    private var header: String? {
        guard let cut = router.cut(of: .matters) else {
            return life.projects.shown().onScreen.map { "\($0.underway) underway" }
        }
        return life.matters.shown().onScreen.map { "\(cut.cut($0.matters, ref: \.id).count) of \($0.matters.count)" }
    }

    /// The read under a chip: All's is every running matter.
    private func list(of chip: ProjectChips.Chip?) -> ReadState<MatterList> {
        chip.map { life.scopedMatters[$0.identity] ?? ReadState() } ?? life.matters
    }

    private func refresh(_ chip: ProjectChips.Chip?) async {
        guard let chip else { return await life.refreshMatters() }
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
        guard sizeClass == .regular else { return }
        // A page that is not a matter, or a matter he opened from elsewhere, stays whatever the chip's list holds.
        if router.detail != nil, router.matter == nil { return }
        if router.isMatterFromElsewhere { return }
        let matters = list(of: chosen).value?.matters
        let isGone = router.matter == nil || matters?.contains { $0.id == router.matter } == false
        router.select(matter: isGone ? matters?.first?.id : router.matter)
    }

    /// The chips, the header of a project's chip, then the chip's rows as their read stands.
    private func content(_ chip: ProjectChips.Chip?) -> some View {
        let shown = list(of: chip).shown()
        let cut = router.cut(of: .matters)
        // Ask Life's cut is of All: Life's rows, the ones it named, in its order.
        let matters = shown.onScreen.map { list in cut.map { $0.cut(list.matters, ref: \.id) } ?? list.matters }
        return List {
            // Its toast stands in the chips' place until his X; one row, so the two cross-fade.
            ZStack(alignment: .leading) {
                if cut == nil { chipRow.transition(.opacity) } else { CutToast(kind: .matters).transition(.opacity) }
            }
            .quietListRow()
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

    /// The rows in Life's order (his marked ones first); on All, a parked or done project's matters last, under
    /// "Parked". A swipe to the right marks one, or unmarks it: the system's own swipe action, as Mail flags a message.
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

    /// All, then Life's chips in its order; one row that scrolls sideways, the chosen chip scrolled into view. A long
    /// press on a project's chip offers Park (or Underway), Mark done and Details.
    private var chipRow: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: Metrics.Spacing.s) {
                    // All is on too when Life no longer lists the chip chosen (a project marked done).
                    FilterChip(name: "All", isOn: chosen == nil) { (router.chip, router.cut) = (nil, nil) }.id("")
                    // Life's chips could not be read: their retry, in their place.
                    if life.projects.hasFailed {
                        QuietChip("Retry", symbol: "arrow.clockwise", isBusy: isRetrying) {
                            Task {
                                (isRetrying, hasRetryFailed) = (true, false)
                                await life.refreshProjects()
                                (isRetrying, hasRetryFailed) = (false, life.projects.hasFailed)
                            }
                        }
                        if hasRetryFailed && !isRetrying { StateMark(glyph: .flag, word: "Still not readable") }
                    }
                    ForEach(life.projects.shown().onScreen?.chips ?? [], id: \.identity) { chip in
                        let status = chip.status.map { life.status(of: chip.id, as: $0) }
                        FilterChip(
                            name: chip.name, icon: MatterIcons.areaSymbol(chip.area ?? chip.id),
                            isOn: router.chip == chip.identity, needsYou: chip.needYou > 0,
                            isWorking: chip.agentAtWork, isDimmed: status.map { !$0.isUnderway } ?? false
                        ) {
                            router.chip = chip.identity
                        }
                        .contextMenu { if let status { menu(chip, status: status) } }
                        .id(chip.identity)
                    }
                }
                .padding(.horizontal, Metrics.gutter)
            }
            .scrollIndicators(.hidden)
            .onChange(of: router.chip, initial: true) { _, chip in
                withAnimation(Motion.standard) { proxy.scrollTo(chip ?? "", anchor: .center) }
            }
        }
        .padding(.bottom, Metrics.Spacing.s)
    }

    /// A project's chip, pressed long: its status in one tap each way (said back with Undo; he stays on the chip),
    /// and its Details.
    @ViewBuilder private func menu(_ chip: ProjectChips.Chip, status: ProjectStatus) -> some View {
        let set = { (to: ProjectStatus, words: String) -> Void in
            Task { await life.setStatus(of: chip.id, named: chip.name, to: to, was: status, words: words) }
        }
        if status.isUnderway {
            Button("Park", systemImage: "square") { set(.parked, "Parked") }
        } else {
            Button("Underway", systemImage: "arrow.uturn.backward") { set(.active, "Underway") }
        }
        if status != .done { Button("Mark done", systemImage: "checkmark") { set(.done, "Done") } }
        Button("Details", systemImage: "info.circle") { router.openDetails(of: chip.id) }
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
