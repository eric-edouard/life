import LifeConnector
import SwiftUI

/// One matter in full: where it stands, his goal and next step (editable), the card waiting on him, the agent on it, who
/// is in it, and its steps, newest first.
struct MatterPage: View {
    let id: String

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @State private var showsStart = false

    var body: some View {
        let state = life.matter[id] ?? ReadState()
        ReadScreen(
            shown: state.shown(), retry: { await life.refreshMatter(id) },
            loading: { PagePlaceholder() },
            empty: { Notice(title: "This matter is gone.", detail: "Life no longer lists it.") },
            content: { matter in page(matter) }
        )
        .background(Palette.bg)
        .toolbar(.hidden, for: .navigationBar)
        .toolbarVisibility(.hidden, for: .tabBar)
        .safeAreaInset(edge: .top, spacing: 0) { TopBar(label: "Matter") { router.matters.removeAll { $0 == id } } }
        .task { await life.refreshMatter(id) }
    }

    private func page(_ matter: Matter) -> some View {
        let row = matter.row
        let open = life.inbox.value?.checks.first { $0.matter?.id == id }
        let agent = matter.agents.first { $0.status != .ended }
        return ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header(matter)
                GoalAndNext(matter: matter)
                if let open { CardLink(check: open) { router.answer(card: open.ref) } }
                if let agent { AgentBlock(agent: agent) } else { NoAgent() }
                People(people: row.people)
                Steps(steps: matter.steps)
            }
            .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 24).readingWidth()
        }
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .safeAreaInset(edge: .bottom, spacing: 8) {
            VStack(spacing: 8) {
                if agent == nil { Button("Start an agent") { showsStart = true }.buttonStyle(.pill(.filled)) }
                DoneButton(matter: matter)
            }
            .padding(.horizontal, 20).padding(.bottom, 8).readingWidth().background(Palette.bg)
        }
        .sheet(isPresented: $showsStart, onDismiss: { life.forget(.start(matter: id)) }) {
            StartAgentSheet(matter: matter)
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
                .font(.manrope(15, weight: 450)).foregroundStyle(Palette.muted)
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
                save: { text in await life.setGoal(of: matter, text) })
            Hairline()
            EditableLine(
                label: "Next step", text: matter.row.nextStep?.text ?? "",
                state: life.state(of: .edit(matter: matter.row.id, .next)),
                save: { text in await life.setNextStep(of: matter, NextStepRequest(kind: "do", text: text)) })
        }
        .card(radius: 22)
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
                TextField(label, text: $draft, axis: .vertical).focused($focused).font(.manrope(18, weight: 500))
                    .foregroundStyle(Palette.fg).lineLimit(1...6)
                HStack(spacing: 8) {
                    Button("Cancel") { isEditing = false }.buttonStyle(.pill(.quiet, height: 44))
                    Button(state.isRunning ? "Saving…" : "Save") {
                        Task {
                            await save(draft.trimmingCharacters(in: .whitespacesAndNewlines))
                            if case .failed = state {} else { isEditing = false }
                        }
                    }
                    .buttonStyle(.pill(.filled, height: 44)).disabled(
                        state.isRunning || draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } else {
                Text(text.isEmpty ? "Not set" : text).font(.manrope(18, weight: 500))
                    .foregroundStyle(text.isEmpty ? Palette.faint : Palette.fg).fixedSize(
                        horizontal: false, vertical: true)
            }
            if case .failed(let failure, _) = state {
                Text(failure.reason).font(.small).foregroundStyle(Palette.flag)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
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
                Text(check.question).font(.manrope(17, weight: 500)).foregroundStyle(Palette.fg).lineLimit(2)
                Spacer(minLength: 4)
                Text("Answer \(Image(systemName: "chevron.right"))").font(.manrope(16, weight: 600)).foregroundStyle(
                    Palette.fg)
            }
            .padding(.horizontal, 18).padding(.vertical, 16)
            .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(Palette.flag, lineWidth: 1.5) }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

// MARK: Agent

private struct NoAgent: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No agent on this matter").font(.manrope(18, weight: 600)).foregroundStyle(Palette.fg)
            Text("Start one and its first step is a plan you approve. Nothing is sent without your tap.")
                .font(.body15).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .overlay {
            RoundedRectangle(cornerRadius: 22).strokeBorder(
                Palette.line, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
        }
    }
}

private struct AgentBlock: View {
    let agent: RegisteredAgent
    @Environment(LifeStore.self) private var life
    @Environment(\.openURL) private var openURL

    var body: some View {
        let state = life.state(of: .agent(agent.id))
        let isStopped = agent.status == .stopped
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Label(agent.provider.name, systemImage: "sparkle").font(.manrope(17, weight: 600)).foregroundStyle(
                    Palette.ai)
                if let model = agent.model {
                    Text(model).font(.manrope(16, weight: 450)).foregroundStyle(Palette.muted)
                }
                Spacer()
                if agent.wait?.reason == "his answer" { Caps("Waits on you", color: Palette.flag) }
            }
            Text(status).font(.manrope(18, weight: 600)).foregroundStyle(Palette.fg).fixedSize(
                horizontal: false, vertical: true)
            if let turn = agent.lastTurn, let outcome = turn.outcome {
                Text("Last turn, \((turn.endedAt ?? turn.startedAt).formatted(.dateTime.hour().minute())): \(outcome)")
                    .font(.body15).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                if let link = agent.link.flatMap(URL.init(string:)) {
                    Button {
                        openURL(link)
                    } label: {
                        Text("Open in \(agent.provider.name) \(Image(systemName: "arrow.up.right"))").lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .buttonStyle(.pill(.quiet, height: 48))
                }
                Button {
                    Task { isStopped ? await life.resumeAgent(agent.id) : await life.stopAgent(agent.id) }
                } label: {
                    Label(
                        state.isRunning ? "Working…" : isStopped ? "Resume" : "Stop",
                        systemImage: isStopped ? "play" : "stop")
                }
                .buttonStyle(.pill(.quiet, height: 48)).disabled(state.isRunning)
            }
            if case .failed(let failure, _) = state {
                Text(failure.reason).font(.small).foregroundStyle(Palette.flag)
            }
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading).card(radius: 22)
    }

    private var status: String {
        if let wait = agent.wait {
            return "Waiting for \(wait.reason), until \(wait.until.formatted(.dateTime.weekday(.wide).hour().minute()))"
        }
        switch agent.status {
        case .running: return "Working on it"
        case .stopped: return "Stopped"
        case .ended, .handedOver: return agent.outcome ?? "Finished"
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
                ForEach(groups.flatMap { role, names in names.map { (role, $0) } }, id: \.1) { role, name in
                    HStack(spacing: 8) {
                        Text(
                            name.split(separator: " ").prefix(2).compactMap { $0.first.map(String.init) }.joined()
                                .uppercased()
                        )
                        .font(.manrope(11, weight: 650)).foregroundStyle(Palette.muted)
                        .frame(width: 30, height: 30).background(Color.fillTint, in: .circle)
                        Text(role).font(.manrope(15, weight: 450)).foregroundStyle(Palette.muted)
                        Text(name).font(.manrope(16, weight: 600)).foregroundStyle(Palette.fg)
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
                Text("\(steps.count), newest first").font(.manrope(15, weight: 450)).foregroundStyle(Palette.muted)
            }
            .padding(.top, 10)
            ForEach(Array(steps.reversed().enumerated()), id: \.element.id) { offset, step in
                HStack(alignment: .top, spacing: 14) {
                    Text(String(format: "%02d", steps.count - offset)).font(.monoSmall).foregroundStyle(Palette.muted)
                        .frame(width: 22, alignment: .leading).padding(.top, 3)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(
                            [step.at.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)), step.with]
                                .compactMap(\.self).joined(separator: " · ")
                        )
                        .font(.manrope(14, weight: 450)).foregroundStyle(Palette.muted)
                        Text(step.kind.replacing("_", with: " ")).label().foregroundStyle(
                            step.ending == nil ? Palette.fg : Palette.faint)
                        Text(step.text).font(.manrope(17, weight: 600)).foregroundStyle(
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
    let matter: Matter
    @Environment(LifeStore.self) private var life

    var body: some View {
        let state = life.state(of: .edit(matter: matter.row.id, .done))
        VStack(spacing: 6) {
            Button {
                Task { await life.markDone(matter) }
            } label: {
                switch state {
                case .running: Text("Marking it done…")
                case .succeeded: Label("Marked as done", systemImage: "checkmark")
                default: Label("Mark as done", systemImage: "checkmark")
                }
            }
            .buttonStyle(.pill(.quiet)).disabled(state.isRunning)
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
