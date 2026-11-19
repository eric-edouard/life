import LifeConnector
import SwiftUI

/// One matter in full: where it stands, his goal and next step (editable), the card waiting on him, the agent on it, who
/// is in it, and its steps, newest first.
struct MatterPage: View {
    let id: String

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        let state = life.matter[id] ?? ReadState()
        ReadScreen(
            shown: state.shown(), retry: { await life.refreshMatter(id) },
            loading: { PagePlaceholder() },
            empty: { Notice(title: "This matter is gone.", detail: "Life no longer lists it.") },
            content: { matter in page(matter) }
        )
        .background(Palette.bg)
        // Beside the list the Pendant is already in the list's bar.
        .shellBar("Matter", hasSettings: false, hasPendant: sizeClass != .regular)
        .task { await life.refreshMatter(id) }
    }

    private func page(_ matter: Matter) -> some View {
        let row = matter.row
        let open = life.inbox.value?.checks.first { $0.matter?.id == id }
        // Life lists the active one first, else the newest past one: an ended agent shows how it ended.
        let agent = matter.agents.first
        let canStart = agent?.isOver ?? true
        return ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header(matter)
                GoalAndNext(matter: matter)
                if let open { CardLink(check: open) { router.answer(card: open.ref) } }
                if let agent {
                    AgentBlock(agent: agent, waitsOnYou: open != nil || row.wait == .decision)
                } else {
                    NoAgent()
                }
                People(people: row.people)
                Steps(steps: matter.steps)
            }
            .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 24).readingWidth()
        }
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .safeAreaInset(edge: .bottom, spacing: 8) {
            VStack(spacing: 8) {
                if canStart {
                    Button(agent == nil ? "Start an agent" : "Start again") { router.startSheetMatter = id }
                        .buttonStyle(.pill(.filled))
                }
                DoneButton(id: id)
            }
            .padding(.horizontal, 20).padding(.bottom, 8).readingWidth().background(Palette.bg)
        }
    }

    private func header(_ matter: Matter) -> some View {
        let row = matter.row
        let days = matter.steps.first.map { Calendar.current.dateComponents([.day], from: $0.at, to: .now).day ?? 0 }
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                if let wait = row.wait?.line(waitsOn: row.nextStep?.waitsOn) {
                    Text(wait.text).label().foregroundStyle(wait.needsYou ? Palette.flag : Palette.fg)
                }
                Text(
                    ([days.map { "open \($0) day\($0 == 1 ? "" : "s")" }].compactMap(\.self)
                        + [(row.areas ?? []).joined(separator: ", ")].filter { !$0.isEmpty }).joined(separator: " · ")
                )
                .font(.body15).foregroundStyle(Palette.muted)
            }
            Text(row.name).font(.matterTitle).foregroundStyle(Palette.fg).fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
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

/// A card of his waiting on this matter.
private struct CardLink: View {
    let check: Check
    let answer: () -> Void

    var body: some View {
        Button(action: answer) {
            HStack(spacing: 12) {
                Caps("1 card", color: Palette.flag)
                Text(check.question).font(.lead).foregroundStyle(Palette.fg).lineLimit(2)
                Spacer(minLength: 4)
                Text("Answer \(Image(systemName: "chevron.right"))").font(.rowName).foregroundStyle(
                    Palette.fg)
            }
            .padding(.horizontal, 18).padding(.vertical, 16)
            .overlay { RoundedRectangle(cornerRadius: Metrics.Radius.card).strokeBorder(Palette.flag, lineWidth: 1.5) }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

// MARK: Agent

private struct NoAgent: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No agent on this matter").font(.leadBold).foregroundStyle(Palette.fg)
            Text("Start one and its first step is a plan you approve. Nothing is sent without your tap.")
                .font(.body15).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .overlay {
            RoundedRectangle(cornerRadius: Metrics.Radius.card).strokeBorder(
                Palette.line, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
        }
    }
}

private struct AgentBlock: View {
    let agent: RegisteredAgent
    /// A card of this matter waits on him, or its next step is his decision.
    let waitsOnYou: Bool
    @Environment(LifeStore.self) private var life
    @Environment(\.openURL) private var openURL

    var body: some View {
        let state = life.state(of: .agent(agent.id))
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Label(agent.runtimeName.name, systemImage: "sparkle").font(.leadBold).foregroundStyle(
                    Palette.ai)
                if let model = agent.model {
                    Text(model).font(.lead).foregroundStyle(Palette.muted)
                }
                Spacer()
                if waitsOnYou && !agent.isOver { Caps("Waits on you", color: Palette.flag) }
            }
            Text(status).font(.leadBold).foregroundStyle(Palette.fg).fixedSize(
                horizontal: false, vertical: true)
            if let turn = agent.lastTurn, let outcome = turn.outcome {
                Text("Last turn, \((turn.endedAt ?? turn.startedAt).formatted(.dateTime.hour().minute())): \(outcome)")
                    .font(.body15).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            controls(state)
            if case .failed(let failure, _) = state {
                Text(failure.reason).font(.small).foregroundStyle(Palette.flag)
            }
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading).card()
    }

    /// Its session's link, and Stop or Resume while it is not over.
    private func controls(_ state: ActionState<ActionProof>) -> some View {
        let isStopped = agent.status == .stopped
        return HStack(spacing: 8) {
            if let link = agent.link.flatMap(URL.init(string:)) {
                TextLink("Open in \(agent.runtimeName.name)", isOutward: true) { openURL(link) }
            }
            if !agent.isOver {
                Button {
                    Task { isStopped ? await life.resumeAgent(agent.id) : await life.stopAgent(agent.id) }
                } label: {
                    if state.isRunning {
                        Text("Working…")
                    } else {
                        Label(isStopped ? "Resume" : "Stop", systemImage: isStopped ? "play" : "stop")
                    }
                }
                .buttonStyle(.pill(.quiet, size: .compact, isBusy: state.isRunning))
                .disabled(state.isRunning)
            }
        }
    }

    private var status: String {
        if let wait = agent.wait {
            // The agent's own words for what it waits for, as it wrote them.
            let until = wait.until.formatted(.dateTime.weekday(.wide).hour().minute())
            return "\(wait.reason.prefix(1).uppercased())\(wait.reason.dropFirst()), until \(until)"
        }
        if let why = agent.notStarted { return "Not started: \(why)" }
        switch agent.status {
        case .running: return "Working on it"
        case .stopped: return "Stopped"
        case .ended: return agent.outcome ?? "Finished"
        case .handedOver: return agent.outcome ?? "Handed over"
        case .waiting, .unknown: return "Waiting"
        }
    }
}

// MARK: People and steps

private struct People: View {
    let people: MatterRow.People?

    var body: some View {
        let groups: [(String, [String])] = [
            ("Owed to", people?.owedTo ?? []), ("Waiting on", people?.waitingOn ?? []),
            ("With", people?.with ?? []), ("Told", people?.told ?? []),
        ].filter { !$0.1.isEmpty }
        if !groups.isEmpty {
            FlowLayout(spacing: 8) {
                // One person can be in two roles: each pill is its role and name.
                ForEach(
                    groups.flatMap { role, names in names.map { (id: "\(role)/\($0)", role: role, name: $0) } },
                    id: \.id
                ) { _, role, name in
                    HStack(spacing: 8) {
                        Text(
                            name.split(separator: " ").prefix(2).compactMap { $0.first.map(String.init) }.joined()
                                .uppercased()
                        )
                        .font(.badge).foregroundStyle(Palette.muted)
                        .frame(width: 30, height: 30).background(Color.fillTint, in: .circle)
                        Text(role).font(.body15).foregroundStyle(Palette.muted)
                        Text(name).font(.rowName).foregroundStyle(Palette.fg)
                    }
                    .padding(.leading, 6).padding(.trailing, 14).frame(minHeight: 44).background(
                        Palette.card, in: .capsule
                    )
                    .accessibilityElement(children: .combine)
                }
            }
        }
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
                        Text(step.kind.replacing("_", with: " ")).label().foregroundStyle(
                            step.ending == nil ? Palette.fg : Palette.faint)
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
            .buttonStyle(.pill(.quiet, isBusy: state.isRunning)).disabled(state.isRunning)
            LimitNote(state: state) { $0.map { "Takes \($0)." } ?? "" }
                .font(.small).foregroundStyle(Palette.faint).multilineTextAlignment(.center)
            if case .failed(let failure, _) = state {
                Text(failure.reason).font(.small).foregroundStyle(Palette.flag).multilineTextAlignment(.center)
            }
        }
    }
}

private struct PagePlaceholder: View {
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
