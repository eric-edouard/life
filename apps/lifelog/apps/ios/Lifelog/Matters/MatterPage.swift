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
            loading: { PagePlaceholder() },
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
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
            }
        }
        .task(id: life.answersEnded) { await life.refreshMatter(id) }
    }

    private func page(_ matter: Matter) -> some View {
        let row = matter.row
        // Life lists the active one first, else the newest past one: an ended agent shows how it ended.
        let agent = matter.agents.first
        let canStart = agent?.isOver ?? true
        return ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header(matter)
                asks(unanswered(matter))
                if let agent {
                    AgentRow(agent: agent) { router.matterSheet = .agent(id) }
                }
                GoalAndNext(matter: matter)
                People(people: row.people)
                Steps(steps: matter.steps)
            }
            .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 24).readingWidth()
        }
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        // Floating over the content: the bar reserves the space and gives the scroll its soft edge.
        .safeAreaBar(edge: .bottom) {
            GlassEffectContainer(spacing: 8) {
                VStack(spacing: 8) {
                    if canStart {
                        Button(agent == nil ? "Start an agent" : "Start again") { router.matterSheet = .start(id) }
                            .primaryGlassButton()
                    }
                    DoneButton(id: id)
                }
                .controlSize(.large).frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 20).padding(.bottom, 8).readingWidth()
        }
    }

    /// Its asks less those whose answer is held for Undo or on its way: the Inbox's rule (`answersUnderWay`).
    private func unanswered(_ matter: Matter) -> [Check] {
        matter.checks.filter { !life.answersUnderWay.contains($0.ref) }
    }

    /// What waits on him here, under the name: each ask of this matter as a row that opens it; nothing when none waits.
    @ViewBuilder private func asks(_ checks: [Check]) -> some View {
        if !checks.isEmpty {
            RowGroup {
                ForEach(checks) { check in
                    Button {
                        router.matterPath.append(.card(check.ref))
                    } label: {
                        Row(title: check.question, detail: check.deadline.map { DeadlineWords.by($0) }) {
                            StateDot(color: Palette.flag)
                            RowValue()
                        }
                    }
                    .buttonStyle(.plain)
                    // The dot has its words.
                    .accessibilityValue(needsYourAnswer)
                }
            }
        }
    }

    /// The name is the head; under it what he must do (one phrase), how long it has been open, and its project, a link
    /// to the project's page (else its areas).
    private func header(_ matter: Matter) -> some View {
        let row = matter.row
        let days = matter.steps.first.map { Calendar.current.dateComponents([.day], from: $0.at, to: .now).day ?? 0 }
        let areas = row.project == nil ? (row.areas ?? []).joined(separator: ", ") : ""
        let open =
            ([days.map { "Open \($0) day\($0 == 1 ? "" : "s")" }].compactMap(\.self) + [areas].filter { !$0.isEmpty })
            .joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 8) {
            Text(row.name).font(.screenName).foregroundStyle(Palette.fg).fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader).stepsAsideForToast()
            if !unanswered(matter).isEmpty { Text(needsYourAnswer).font(.lead).foregroundStyle(Palette.flag) }
            HStack(spacing: 0) {
                Text(open + (row.project == nil || open.isEmpty ? "" : " · ")).font(.small).foregroundStyle(
                    Palette.muted)
                if let project = row.project {
                    TextLink(project.name, isOnward: true, isMuted: false) {
                        router.matterPath.append(.project(project.id))
                    }
                }
            }
        }
        .padding(.top, 8)
    }
}

// MARK: Goal and next step

/// His goal and next step for the matter, each edited in place: saving is an action with its own state, and a failure
/// leaves his words in the field.
private struct GoalAndNext: View {
    let matter: Matter
    @Environment(LifeStore.self) private var life

    var body: some View {
        VStack(spacing: 0) {
            EditableLine(
                label: "Goal", text: matter.row.goal?.text ?? "",
                state: life.state(of: .edit(matter: matter.row.id, .goal)),
                save: { text in await life.setGoal(of: matter.row.id, text) })
            Hairline()
            EditableLine(
                label: "Next step", text: matter.row.nextStep?.text ?? "",
                state: life.state(of: .edit(matter: matter.row.id, .next)),
                save: { text in await life.setNextStep(of: matter.row.id, NextStepRequest(kind: "do", text: text)) })
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
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Caps(label)
                Spacer()
                if !isEditing {
                    Button {
                        draft = text; isEditing = true; focused = true
                    } label: {
                        Image(systemName: "pencil").foregroundStyle(Palette.muted).frame(width: 44, height: 28)
                    }
                    .accessibilityLabel("Edit \(label.lowercased())")
                }
            }
            if isEditing {
                TextField(label, text: $draft, axis: .vertical).focused($focused).font(.lead)
                    .foregroundStyle(Palette.fg).lineLimit(1...6)
                HStack(spacing: 8) {
                    Button("Cancel") { isEditing = false }.buttonStyle(.pill(.quiet, size: .compact))
                    Button(state.isRunning ? "Saving…" : "Save") {
                        Task { await save(draft.trimmingCharacters(in: .whitespacesAndNewlines)) }
                    }
                    .buttonStyle(.pill(.filled, size: .compact, isBusy: state.isRunning))
                    .disabled(state.isRunning || draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } else {
                Text(text.isEmpty ? "Not set" : text).font(.lead)
                    .foregroundStyle(text.isEmpty ? Palette.faint : Palette.fg).fixedSize(
                        horizontal: false, vertical: true)
            }
            if case .failed(let failure, _) = state {
                Text(failure.reason).font(.small).foregroundStyle(Palette.flag)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: state) { if case .succeeded = $1 { isEditing = false } }
    }
}

// MARK: People and steps

private struct People: View {
    let people: MatterRow.People?

    /// One small muted line: "Owed to Ana Novak, with Sam Lee".
    var body: some View {
        let groups: [(String, [String])] = [
            ("Owed to", people?.owedTo ?? []), ("Waiting on", people?.waitingOn ?? []),
            ("With", people?.with ?? []), ("Told", people?.told ?? []),
        ].filter { !$0.1.isEmpty }
        let line = groups.enumerated().map { offset, group in
            let words = "\(group.0) \(group.1.joined(separator: ", "))"
            return offset == 0 ? words : words.prefix(1).lowercased() + words.dropFirst()
        }
        .joined(separator: ", ")
        if !line.isEmpty { Text(line).font(.small).foregroundStyle(Palette.muted) }
    }
}

private struct Steps: View {
    let steps: [MatterStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
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
                switch state {
                case .running: Text("Marking it done…")
                case .succeeded: Label("Marked as done", systemImage: "checkmark")
                default: Label("Mark as done", systemImage: "checkmark")
                }
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
        [at.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)), with].compactMap(\.self)
            .joined(separator: " · ")
    }
}

// MARK: Agent

/// The agent's row on a matter: its runtime in `ai`, one line under it (who it listens for and its deadline, or its state;
/// `flag` when it never started), a chevron. It opens the agent's sheet.
private struct AgentRow: View {
    let agent: RegisteredAgent
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: Metrics.Spacing.s) {
                VStack(alignment: .leading, spacing: 2) {
                    AgentLabel(runtime: agent.runtimeName).font(.bodyStrong)
                    if let line = agent.rowLine() {
                        Text(line).font(.small).foregroundStyle(agent.notStarted == nil ? Palette.muted : Palette.flag)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.smallStrong).foregroundStyle(Palette.muted)
            }
            .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.m)
            .frame(maxWidth: .infinity, alignment: .leading).card().contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }
}
