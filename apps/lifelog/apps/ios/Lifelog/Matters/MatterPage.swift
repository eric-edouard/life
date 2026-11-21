import LifeConnector
import SwiftUI

/// The one phrase for what an open ask of a matter is, on the lead line and on the ask rows.
private let needsYourAnswer = "Needs your answer"

/// One matter in full: where it stands, his goal and next step (editable), the card waiting on him, the agent on it, who
/// is in it, and its steps, newest first.
struct MatterPage: View {
    let id: String
    /// Settings beside the Pendant: on a regular width the list's bar has neither, so the page carries both.
    var hasSettings = false

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    var body: some View {
        let state = life.matter[id] ?? ReadState()
        ReadScreen(
            shown: state.shown(), retry: { await life.refreshMatter(id) },
            // With its row on hand, what the row says shows at once; only its steps and asks wait for the read.
            loading: {
                if let row = life.listedRow(of: id) { rowPage(row) } else { PagePlaceholder() }
            },
            empty: { Notice(title: "This matter is gone.", detail: "Life no longer lists it.") },
            content: { matter in page(matter) }
        )
        .background(Palette.bg)
        .saysBack()
        // Back on the left, his mark, then the Pendant on the right (and Settings when the list's bar has neither): the
        // items of an outer toolbar come first.
        .shellBar("", hasSettings: hasSettings)
        .toolbar {
            if let row = state.value?.row {
                ToolbarItem(placement: .topBarTrailing) {
                    let isOn = life.isImportant(id, as: row.important)
                    MarkItem(isOn: isOn) { Task { await life.setImportant(id, !isOn) } }
                        .offWhileOutOfReach()
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
            }
        }
        .task(id: life.answersEnded[id]) { await life.refreshMatter(id) }
    }

    private func page(_ matter: Matter) -> some View {
        let row = matter.row
        // Its holder; else Life lists the active one first, else the newest past one: an ended agent shows how it ended.
        let holder = matter.holder?.agent.id
        let agent =
            matter.agents.first { $0.id == holder } ?? life.agents.value?.agents.first { $0.id == holder }
            ?? matter.agents.first
        let canStart = agent?.isOver ?? true
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                header(row, openSince: matter.steps.first?.at)
                asks(life.asks(ofMatter: id))
                if let agent {
                    AgentRow(matter: matter, agent: agent) {
                        router.matterSheet = .agent(id, agent: matter.holder?.agent.id ?? agent.id)
                    }
                }
                GoalAndNext(row: row).offWhileOutOfReach()
                People(people: row.people)
                Steps(steps: matter.steps)
                if let line = matter.spendingLine { SpendingLine(text: line) }
            }
            .matterPageColumn()
        }
        // Pinned below the content, full width, on the page's own colour: nothing shows through or around them; the
        // content fades into it above.
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .safeAreaBar(edge: .bottom) {
            GlassEffectContainer(spacing: 8) {
                VStack(spacing: 8) {
                    if canStart {
                        Button {
                            router.matterSheet = .start(id)
                        } label: {
                            Text(agent == nil ? "Start an agent" : "Start again").frame(maxWidth: .infinity)
                        }
                        .primaryGlassButton()
                    }
                    DoneButton(id: id)
                }
                .controlSize(.large)
                .offWhileOutOfReach()
            }
            .padding(.horizontal, 20).padding(.bottom, 8).readingWidth()
            .padding(.top, Metrics.Spacing.m).frame(maxWidth: .infinity)
            .background(Palette.bg.ignoresSafeArea(edges: .bottom))
        }
    }

    /// The page as its list row draws it, before the matter's read: its steps and asks are placeholders, its goal and
    /// next step not yet editable.
    private func rowPage(_ row: MatterRow) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header(row, openSince: nil)
                // Edited once the read lands: that face is a new view, which would not hold his words saved here.
                GoalAndNext(row: row).disabled(true)
                People(people: row.people)
                Placeholder(height: 110)
            }
            .matterPageColumn()
        }
    }

    /// What waits on him here, under the name: each ask of this matter as a row that opens it; nothing when none waits.
    @ViewBuilder private func asks(_ checks: [Check]) -> some View {
        if !checks.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(checks.enumerated()), id: \.element.ref) { at, check in
                    Button {
                        router.matterPath.append(.card(check.ref))
                    } label: {
                        Row(
                            title: check.question, detail: check.deadline.map { DeadlineWords.by($0) }, isInList: true
                        ) {
                            StateDot(color: Palette.flag)
                            RowValue()
                        }
                    }
                    .buttonStyle(.groupedRow(at: at, of: checks.count))
                    // The dot has its words.
                    .accessibilityValue(needsYourAnswer)
                }
            }
            // The card on the page's gutter: a list keeps its inset from its column's edges.
            .padding(.horizontal, -Metrics.Spacing.m)
        }
    }

    /// The name is the head; under it what he must do (one phrase), then its icon (a tap changes it), how long it has
    /// been open (since its first step, once read), and its project, a link to its chip in the Projects tab (else its
    /// areas).
    private func header(_ row: MatterRow, openSince: Date?) -> some View {
        let days = openSince.map { Calendar.current.dateComponents([.day], from: $0, to: .now).day ?? 0 }
        let areas = row.project == nil ? (row.areas ?? []).joined(separator: ", ") : ""
        let open =
            ([days.map { "Open \($0) day\($0 == 1 ? "" : "s")" }].compactMap(\.self) + [areas].filter { !$0.isEmpty })
            .joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 8) {
            Text(row.name).font(.screenName).foregroundStyle(Palette.fg).fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader).stepsAsideForToast()
            if !life.asks(ofMatter: id).isEmpty { Text(needsYourAnswer).font(.lead).foregroundStyle(Palette.flag) }
            HStack(spacing: 6) {
                MetaIconButton(symbol: row.symbol, label: "Change the icon") { router.matterSheet = .icon(id) }
                HStack(spacing: 0) {
                    Text(open + (row.project == nil || open.isEmpty ? "" : " · ")).font(.small).foregroundStyle(
                        Palette.muted)
                    if let project = row.project {
                        TextLink(project.name, to: .page) {
                            // A done project has no chip: its Details, then.
                            if project.status == .done {
                                router.openDetails(of: project.id)
                            } else {
                                router.open(project: ProjectChips.Chip.identity(.project, project.id))
                            }
                        }
                    }
                }
            }
        }
        .padding(.top, 8)
    }
}

extension View {
    /// The page's column, its row-drawn face's too.
    fileprivate func matterPageColumn() -> some View {
        padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 24).readingWidth()
    }
}

// MARK: Goal and next step

/// His goal and next step for the matter, each edited in place: saving is an action with its own state, and a failure
/// leaves his words in the field.
private struct GoalAndNext: View {
    let row: MatterRow
    @Environment(LifeStore.self) private var life

    var body: some View {
        VStack(spacing: 0) {
            EditableLine(
                label: "Goal", text: row.goal?.text ?? "",
                state: life.state(of: .edit(matter: row.id, .goal)),
                save: { text in await life.setGoal(of: row.id, text) })
            Hairline()
            EditableLine(
                label: "Next step", text: row.nextStep?.text ?? "",
                state: life.state(of: .edit(matter: row.id, .next)),
                save: { text in await life.setNextStep(of: row.id, NextStepRequest(kind: "do", text: text)) })
        }
        .card()
    }
}

private struct EditableLine: View {
    let label: String
    let text: String
    let state: ActionState<ActionProof>
    let save: (String) async -> Void

    @State private var isEditing = false
    @State private var draft = ""
    /// His words Life saved, shown in place of `text` until a read changes it: a read asked before the save, landing
    /// after it, shows the same old text and changes nothing.
    @State private var saved: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Caps(label)
                Spacer()
                if !isEditing {
                    Button {
                        draft = saved ?? text; isEditing = true; focused = true
                    } label: {
                        Image(systemName: "pencil").foregroundStyle(Palette.muted).frame(width: 44, height: 28)
                    }
                    .accessibilityLabel("Edit \(label.lowercased())")
                }
            }
            if isEditing {
                DictationField(prompt: label, text: $draft, axis: .vertical, focused: $focused).font(.lead)
                    .foregroundStyle(Palette.fg).lineLimit(1...)
                HStack(spacing: 8) {
                    Button("Cancel") { isEditing = false }.buttonStyle(.pill(.quiet, size: .compact))
                    Button(state.isRunning ? "Saving…" : "Save") {
                        Task { await save(draft.trimmingCharacters(in: .whitespacesAndNewlines)) }
                    }
                    .buttonStyle(.pill(.filled, size: .compact, isBusy: state.isRunning))
                    .disabled(state.isRunning || draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } else {
                let shown = saved ?? text
                Text(shown.isEmpty ? "Not set" : shown).font(.lead)
                    .foregroundStyle(shown.isEmpty ? Palette.faint : Palette.fg).fixedSize(
                        horizontal: false, vertical: true)
            }
            if case .failed(let failure, _) = state {
                Text(failure.reason).font(.small).foregroundStyle(Palette.flag)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: state) {
            guard case .succeeded = $1 else { return }
            (saved, isEditing) = (draft.trimmingCharacters(in: .whitespacesAndNewlines), false)
        }
        // A read that says something new is Life's word on it.
        .onChange(of: text) { saved = nil }
    }
}

// MARK: People and steps

private struct People: View {
    let people: MatterRow.People?

    @Environment(AppRouter.self) private var router

    /// One small line of chips, each opening that person's page: "Owed to (disc) Ana Novak, with (disc) Sam Lee".
    var body: some View {
        let groups: [(String, [Party])] = [
            ("Owed to", people?.owedTo ?? []), ("Waiting on", people?.waitingOn ?? []),
            ("With", people?.with ?? []), ("Told", people?.told ?? []),
        ].filter { !$0.1.isEmpty }
        // Each party with the words before it: its group's, on the group's first, lowercase after the first group.
        let chips = groups.enumerated().flatMap { offset, group in
            group.1.enumerated().map { index, party in
                Chip(
                    id: group.0 + party.ref, party: party,
                    label: index > 0 ? nil : offset == 0 ? group.0 : group.0.lowercased())
            }
        }
        if !chips.isEmpty {
            FlowLayout(spacing: Metrics.Spacing.xs) {
                ForEach(chips) { chip in
                    HStack(spacing: 0) {
                        Button {
                            router.open(party: chip.party.ref)
                        } label: {
                            PartyChip(party: chip.party, label: chip.label)
                        }
                        .buttonStyle(.plain)
                        if chip.id != chips.last?.id { Text(",").foregroundStyle(Palette.muted) }
                    }
                }
            }
            .font(.small)
        }
    }

    private struct Chip: Identifiable {
        let id: String
        let party: Party
        let label: String?
    }
}

private struct Steps: View {
    let steps: [MatterStep]

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 16) {
            HStack {
                Caps("Steps")
                Spacer()
                Text("\(steps.count), newest first").font(.body15).foregroundStyle(Palette.muted)
            }
            .padding(.top, 10)
            ForEach(Array(steps.reversed().enumerated()), id: \.element.id) { offset, step in
                HStack(alignment: .top, spacing: 14) {
                    Text(String(format: "%02d", steps.count - offset)).font(.monoSmall).foregroundStyle(Palette.muted)
                        .frame(width: 22, alignment: .leading).padding(.top, 3)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(step.whenAndWith).font(.body15).foregroundStyle(Palette.muted)
                        if step.kind == "todo_item" && step.ending == nil {
                            Text("Open").font(.smallStrong).foregroundStyle(Palette.flag)
                        }
                        Text(step.text).font(.leadBold).foregroundStyle(
                            step.ending == nil ? Palette.fg : Palette.muted)
                        if !step.quote.isEmpty { Text(step.quote).font(.body15).foregroundStyle(Palette.muted) }
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// His word that the matter is done: an action, so it says what it is doing and what came of it.
private struct DoneButton: View {
    let id: String
    @Environment(LifeStore.self) private var life

    var body: some View {
        let state = life.state(of: .edit(matter: id, .done))
        VStack(spacing: 6) {
            Button {
                Task { await life.markDone(id) }
            } label: {
                Group {
                    switch state {
                    case .running: Text("Marking it done…")
                    case .succeeded: Label("Marked as done", systemImage: "checkmark")
                    default: Label("Mark as done", systemImage: "checkmark")
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glass).disabled(state.isRunning)
            LimitNote(state: state) { $0.map { "Takes \($0)." } ?? "" }
                .font(.small).foregroundStyle(Palette.faint).multilineTextAlignment(.center)
            if case .failed(let failure, _) = state {
                Text(failure.reason).font(.small).foregroundStyle(Palette.flag).multilineTextAlignment(.center)
            }
        }
    }
}

struct PagePlaceholder: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Placeholder(width: 200, height: 12)
            Placeholder(width: 280, height: 28)
            Placeholder(height: 150)
            Placeholder(height: 110)
            Spacer()
        }
        .padding(20)
        .accessibilityLabel("Loading the matter")
    }
}

extension MatterStep {
    /// A step's day and who or what it came from, as the matter page and the card's context both show it.
    var whenAndWith: String {
        [at.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)), with?.name].compactMap(\.self)
            .joined(separator: " · ")
    }
}

// MARK: Agent

/// The agent's row on a matter: the holder's mark and name (else its program) in `ai`, "Moved from …" when he moved it
/// there, then one line (a move under way, with its spinner; else who it listens for and its deadline, or its state,
/// `flag` when it never started). It opens the agent's sheet; while a move is possible it is a pull-down menu: Open, or
/// the move, asked once. A move that failed, or its call, says why above it, with Try again when that may be tried.
private struct AgentRow: View {
    let matter: Matter
    let agent: RegisteredAgent
    let open: () -> Void

    @Environment(LifeStore.self) private var life
    @State private var asking: MoveChoice?
    /// The move he last asked here: Try again repeats only it.
    @State private var tried: MoveChoice?

    var body: some View {
        let id = matter.row.id
        let move = life.moveShown(ofMatter: id)
        let call = life.state(of: .move(id))
        let isUnderWay = call.isRunning || move?.phase.isUnderWay == true
        let choice = isUnderWay ? nil : matter.moveChoice(among: life.agents.value?.agents ?? [])
        let holder = matter.holder?.agent.name ?? agent.runtimeName.name
        let ask = asking.map { MoveWords.ask($0, matter: matter.row.name, holder: holder) }
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            let failed = MoveReceipt.failure(
                call: call.failure, shown: move, tried: life.retryable(tried, call: call.failure, shown: move),
                offered: choice)
            if let failed { MoveFailureLine(reason: failed.reason, retry: failed.retry.map { retry in { go(retry) } }) }
            if let choice {
                Menu {
                    Button("Open \(holder)", action: open)
                    Button {
                        asking = choice
                    } label: {
                        let item = MoveWords.item(choice)
                        Text(item.title)
                        if let subtitle = item.subtitle { Text(subtitle) }
                    }
                } label: {
                    row(move, trailing: "chevron.up.chevron.down")
                }
                .menuStyle(.button).buttonStyle(.plain)
            } else {
                Button(action: open) { row(move, trailing: "chevron.right") }.buttonStyle(.plain)
            }
        }
        .alert(
            ask?.title ?? "",
            isPresented: Binding {
                asking != nil
            } set: {
                if !$0 { asking = nil }
            }, presenting: asking
        ) {
            choice in
            Button("Cancel", role: .cancel) {}
            Button("Move") { go(choice) }
        } message: { _ in
            Text(ask?.message ?? "")
        }
        // While it moves, the page reads the matter and the agents every 3 s, until the move rests or the page goes.
        .task(id: isUnderWay) {
            guard isUnderWay else { return }
            while (try? await Task.sleep(for: .seconds(3))) != nil {
                async let a: Void = life.refreshMatter(id)
                async let b: Void = life.refreshAgents()
                _ = await (a, b)
            }
        }
    }

    private func go(_ choice: MoveChoice) {
        tried = choice
        let said =
            switch choice {
            case .runtime(let runtime): "Move it to \(runtime.name)."
            case .back(_, let name): "Move it back to the \(name)."
            }
        Task { await life.move(matter: matter.row.id, to: choice, said: said) }
    }

    private func row(_ move: AgentMove?, trailing: String) -> some View {
        let holder = matter.holder?.agent
        let underWay = move.flatMap { MoveWords.underWay($0, runtime: holder?.runtimeName ?? agent.runtimeName) }
        return HStack(spacing: Metrics.Spacing.s) {
            VStack(alignment: .leading, spacing: 2) {
                AgentLabel(runtime: holder?.runtimeName ?? agent.runtimeName, name: holder?.name).font(.bodyStrong)
                if let underWay {
                    HStack(spacing: 6) {
                        Spinner(size: .small)
                        Text(underWay).lineLimit(1)
                    }
                    .font(.small).foregroundStyle(Palette.muted)
                } else {
                    if let from = matter.holder?.movedFrom {
                        Text("Moved from \(from.name)").font(.small).foregroundStyle(Palette.muted).lineLimit(1)
                    }
                    if let line = agent.rowLine() {
                        Text(line).font(.small).foregroundStyle(agent.notStarted == nil ? Palette.muted : Palette.flag)
                            .lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 0)
            Image(systemName: trailing).font(.smallStrong).foregroundStyle(Palette.muted)
        }
        .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.m)
        .frame(maxWidth: .infinity, alignment: .leading).card().contentShape(.rect)
        .accessibilityElement(children: .combine)
        .motion(Motion.standard, value: underWay)
    }
}

/// Why a move or a switch, or its call, failed, in `flag`, with Try again when it repeats the same one (`MoveReceipt.failure`).
struct MoveFailureLine: View {
    let reason: String
    let retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Metrics.Spacing.s) {
            Text(reason).font(.small).foregroundStyle(Palette.flag).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let retry { QuietChip("Try again", symbol: "arrow.clockwise", action: retry) }
        }
    }
}

extension ActionState {
    /// Why it failed, when it did.
    var failure: ActionFailure? {
        if case .failed(let failure, _) = self { failure } else { nil }
    }
}
