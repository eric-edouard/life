import LifeConnector
import SwiftUI

/// The "your move" asks as a list to sort, not cards (the Inbox's Filter, "Your moves"): filtered by age, project or
/// person, each row answered by swipe (Done, Hand, Drop) or many at once from Select, every answer that card's own
/// option sent at once, each row working until Life answers, then one toast per tap. Life decides what is open and what
/// an option does; this only joins the checks to their matters (`YourMoves`) and sends. A row Life refused shows why on the row.
struct MovesList: View {
    /// The your move asks open now, in the inbox's order.
    let checks: [Check]

    @Environment(LifeStore.self) private var life
    @State private var filter = YourMoves.Filter.all
    @State private var isSelecting = false
    @State private var ticked: Set<String> = []
    @State private var showsDead = false
    /// The rows a Select act sent: only those show their refusal as a group above the bar.
    @State private var sent: Set<String> = []
    @State private var opened: String?
    @State private var openedNotes = CardNotes()
    @State private var openedCurrent: String?

    var body: some View {
        let moves = YourMoves(checks: checks, matters: life.matters.value?.matters ?? [], now: Date())
        let rows = moves.shown(filter)
        List {
            header(moves).quietListRow()
            if filter == .all, !isSelecting, !moves.dead.isEmpty { dead(moves).quietListRow() }
            if rows.isEmpty {
                Text("Nothing here.").font(.body15).foregroundStyle(Palette.muted).padding(Metrics.gutter)
                    .quietListRow()
            }
            ForEach(sections(of: rows, in: moves), id: \.heading) { section in
                ListLabel(section.heading) {
                    if isSelecting {
                        QuietChip(allTicked(section.moves) ? "Untick all" : "Tick all") {
                            toggle(section.moves)
                        }
                    }
                }
                .quietListRow()
                ForEach(Array(section.moves.enumerated()), id: \.element.id) { at, move in
                    row(move, at: at, of: section.moves.count).quietListRow()
                }
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden).background(Palette.bg)
        .safeAreaPadding(.bottom, Metrics.Spacing.xl)
        .safeAreaBar(edge: .bottom, spacing: 0) { if isSelecting { actions(rows) } }
        .motion(Motion.standard, value: rows.map(\.id))
        // Select on the title's row, at its right (DuoFoldMoves).
        .screenTitle("Your move", state: "\(moves.moves.count)") {
            QuietChip(isSelecting ? "Cancel" : "Select") {
                isSelecting.toggle()
                // A filter already chosen is a pick: Select ticks what it shows.
                ticked = isSelecting && filter != .all ? Set(moves.shown(filter).map(\.id)) : []
                sent = []
            }
        }
        .sheet(
            isPresented: Binding(get: { opened != nil }, set: { if !$0 { opened = nil } }),
            onDismiss: { openedNotes = CardNotes() }
        ) {
            if let check = checks.first(where: { $0.ref == opened }) {
                NavigationStack {
                    CardView(
                        check: check, checks: [check], current: $openedCurrent, notes: $openedNotes,
                        context: ContextRegion(check: check, runtimeName: life.runtimeName(of: check)),
                        takes: { taken in
                            Task { await life.answerRows([taken.request], as: taken.heldWords) }
                            opened = nil
                        }
                    ) { _, _ in opened = nil }
                    .background(Palette.bg)
                    .toolbar { CloseItem { opened = nil } }
                }
            }
        }
        // A read can take a ticked row away (answered elsewhere): ticks only name rows still shown.
        .onChange(of: rows.map(\.id)) { _, ids in ticked.formIntersection(ids) }
    }

    // MARK: Header

    private func header(_ moves: YourMoves) -> some View {
        chips(moves).padding(.bottom, Metrics.Spacing.s)
    }

    /// All, Over a month, then the projects and people the moves are in.
    private func chips(_ moves: YourMoves) -> some View {
        let order = life.projects.shown().onScreen?.chips.filter { $0.kind == .project }.map(\.id) ?? []
        return ScrollView(.horizontal) {
            HStack(spacing: Metrics.Spacing.s) {
                FilterChip(name: "All", isOn: filter == .all) { choose(.all) }
                FilterChip(name: "Over a month", isOn: filter == .overMonth) { choose(.overMonth) }
                ForEach(moves.projects(in: order), id: \.project.id) { entry in
                    // The project's own icon, as its chip shows it in Projects.
                    let chip = life.projects.value?.chips.first { $0.kind == .project && $0.id == entry.project.id }
                    FilterChip(
                        name: entry.project.name, icon: chip.map { MatterIcons.areaSymbol($0.area ?? $0.id) },
                        isOn: filter == .project(entry.project.id)
                    ) {
                        choose(.project(entry.project.id))
                    }
                }
                ForEach(moves.people(), id: \.ref) { person in
                    FilterChip(name: person.name, isOn: filter == .person(person.ref)) { choose(.person(person.ref)) }
                }
            }
            .padding(.horizontal, Metrics.gutter)
        }
        .scrollIndicators(.hidden)
    }

    /// A chip on alone, or a second tap on it back to All; two filters at once are not offered.
    private func choose(_ next: YourMoves.Filter) { filter = filter == next ? .all : next }

    /// The group of moves whose matter has gone quiet: one row that shows them, and Close, which drops them all.
    private func dead(_ moves: YourMoves) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ListLabel("Looks dead") {
                if moves.dead.contains(where: { $0.answer("drop") != nil }) {
                    QuietChip("Close \(moves.dead.count)") {
                        act(moves.dead, "drop", words: "\(moves.dead.count) dropped")
                    }
                }
            }
            Button {
                showsDead.toggle()
            } label: {
                Row(
                    title: "\(moves.dead.count) look dead", icon: "moon",
                    detail: "Nothing has moved on them for a while",
                    isInList: true
                ) {
                    Image(systemName: showsDead ? "chevron.down" : "chevron.right").foregroundStyle(Palette.muted)
                }
            }
            .buttonStyle(.groupedRow(at: 0, of: showsDead ? 1 + moves.dead.count : 1))
            if showsDead {
                ForEach(Array(moves.dead.enumerated()), id: \.element.id) { at, move in
                    row(move, at: at + 1, of: moves.dead.count + 1)
                }
            }
        }
    }

    // MARK: Rows

    private struct Section {
        let heading: String
        let moves: [YourMoves.Move]
    }

    /// On All, the moves over a month then the others (the dead have their own group); under a chip, one group.
    private func sections(of rows: [YourMoves.Move], in all: YourMoves) -> [Section] {
        if filter == .all {
            let alive = rows.filter { !$0.looksDead || isSelecting }
            let old = alive.filter(\.isOverMonth)
            let newer = alive.filter { !$0.isOverMonth }
            return [Section(heading: "Older than a month", moves: old), Section(heading: "Newer", moves: newer)]
                .filter { !$0.moves.isEmpty }
        }
        let heading = "\(filterName(all)) · \(rows.count)"
        return rows.isEmpty ? [] : [Section(heading: heading, moves: rows)]
    }

    private func filterName(_ all: YourMoves) -> String {
        switch filter {
        case .all: "All"
        case .overMonth: "Older than a month"
        case .project(let id): all.moves.lazy.compactMap(\.project).first { $0.id == id }?.name ?? "Project"
        case .person(let ref):
            all.moves.lazy.flatMap(\.people).first { $0.ref == ref }.map { "With \($0.name)" } ?? "Person"
        }
    }

    private func row(_ move: YourMoves.Move, at index: Int, of count: Int) -> some View {
        let refused = failure(of: move)
        // The list's one row (`Row`): its matter's icon in the 28 slot (as Projects draws it), the matter, then the step
        // and its age, or why Life refused it, in `flag`.
        let content = Row(
            title: move.check.title, icon: isSelecting ? nil : move.symbol,
            iconTint: Palette.muted, detail: move.detail,
            state: refused.map { .refused($0.reason) }
                ?? (life.state(of: .answer(ref: move.id)).isRunning ? .saving : .known),
            isInList: true)
        return Group {
            if isSelecting {
                TickRow(isTicked: ticked.contains(move.id), tick: { tick(move) }, open: { opened = move.id }) {
                    content
                }
                .padding(.leading, Metrics.Spacing.s)
                .groupedRow(at: index, of: count)
            } else {
                Button {
                    opened = move.id
                } label: {
                    content
                }.buttonStyle(.groupedRow(at: index, of: count))
            }
        }
        .accessibilityElement(children: .combine)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if move.answer("done") != nil {
                Button("Done", systemImage: "checkmark") { act([move], "done", words: "Done") }.tint(Color.pick)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if move.answer("drop") != nil {
                Button("Drop", systemImage: "xmark") { act([move], "drop", words: "Dropped") }.tint(Color.fillTint)
            }
            if move.answer("start") != nil {
                Button("Hand", systemImage: "arrow.right.circle") { act([move], "start", words: "Handed to an agent") }
                    .tint(Palette.ai)
            }
        }
    }

    // MARK: Ticks

    private func tick(_ move: YourMoves.Move) {
        if ticked.contains(move.id) { ticked.remove(move.id) } else { ticked.insert(move.id) }
    }

    private func allTicked(_ moves: [YourMoves.Move]) -> Bool { moves.allSatisfy { ticked.contains($0.id) } }

    private func toggle(_ moves: [YourMoves.Move]) {
        if allTicked(moves) { ticked.subtract(moves.map(\.id)) } else { ticked.formUnion(moves.map(\.id)) }
    }

    // MARK: Answers

    /// The bar over the list while selecting: Hand N (the moves that offer it), Done, Drop (only where Life offers it),
    /// and the reason when Life refused rows its last tap sent.
    private func actions(_ rows: [YourMoves.Move]) -> some View {
        let picked = rows.filter { ticked.contains($0.id) && !mayHaveGone($0) }
        let hand = picked.filter { $0.answer("start") != nil }
        let failed = rows.filter { sent.contains($0.id) && failure(of: $0) != nil }
        return VStack(spacing: Metrics.Spacing.s) {
            if let why = failed.first.flatMap(failure(of:)) {
                let words = why.isSameTap && !why.mayHaveHappened ? "not sent to your Mac." : why.reason
                Text("Not sent: \(words)").font(.small).foregroundStyle(Palette.flag)
                    .frame(maxWidth: .infinity, alignment: .leading).appears()
            }
            HStack(spacing: Metrics.Spacing.s) {
                Button(hand.isEmpty ? "Hand" : "Hand \(hand.count)") {
                    act(hand, "start", words: "\(hand.count) handed to \(projectName(of: hand))")
                }
                .buttonStyle(.pill(.filled)).disabled(hand.isEmpty)
                // The check in `ok`: the answer that closes something (decision 98, rule 13).
                Button {
                    act(picked, "done", words: "\(picked.count) done")
                } label: {
                    Label {
                        Text("Done")
                    } icon: {
                        Image(systemName: "checkmark").foregroundStyle(Palette.ok)
                    }
                }
                .buttonStyle(.pill(.quiet)).disabled(picked.isEmpty)
                if picked.contains(where: { $0.answer("drop") != nil }) {
                    Button("Drop") { act(picked, "drop", words: "\(picked.count) dropped") }
                        .buttonStyle(.pill(.quiet))
                }
            }
        }
        .padding(.horizontal, Metrics.gutter).padding(.bottom, Metrics.Spacing.s).readingWidth()
    }

    /// The one project the moves belong to, else "an agent".
    private func projectName(of moves: [YourMoves.Move]) -> String {
        let names = Set(moves.compactMap(\.project?.name))
        return names.count == 1 ? names.first ?? "an agent" : "an agent"
    }

    /// The option `id` on each of `moves` that offers it, sent at once: the rows work until Life has answered them all.
    private func act(_ moves: [YourMoves.Move], _ id: String, words: String) {
        let requests = moves.compactMap { $0.answer(id) }
        guard !requests.isEmpty, !life.saysOutOfReach() else { return }
        // A new attempt: an earlier refusal of these rows is no longer theirs.
        requests.forEach { life.forget(.answer(ref: $0.ref)) }
        sent.formUnion(requests.map(\.ref))
        ticked.subtract(requests.map(\.ref))
        Task { await life.answerRows(requests, as: words) }
    }

    private func failure(of move: YourMoves.Move) -> ActionFailure? {
        if case .failed(let failure, _) = life.state(of: .answer(ref: move.id)) { failure } else { nil }
    }

    /// Its last answer may have reached Life: never sent again from here.
    private func mayHaveGone(_ move: YourMoves.Move) -> Bool { failure(of: move)?.mayHaveHappened == true }
}
