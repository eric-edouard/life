import LifeConnector
import SwiftUI

/// "Work on this": his goal in his words, who works on it, then the start as Life reports it, stage by stage.
/// The phone has no default of its own: a runtime is sent only when he picks one.
struct StartAgentSheet: View {
    let matter: Matter

    @Environment(LifeStore.self) private var life
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var goal = ""
    @State private var runtimeName: RuntimeName?
    @State private var model: RuntimeName.Model?

    private var state: ActionState<ActionProof> { life.state(of: .start(matter: matter.row.id)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch state {
            case .idle: form
            case .running: progress
            case .succeeded(let proof, _): started(proof)
            case .failed(let failure, _): notStarted(failure)
            }
        }
        .sheetScroll {
            SheetHeader(title: title, color: titleColor) { dismiss() }
        } buttons: {
            buttons
        }
        .background(Palette.sheet)
        .presentationDetents([.large])
        .onAppear { if goal.isEmpty { goal = matter.row.goal?.text ?? "" } }
        .sheetStack()
    }

    private var titleColor: Color {
        switch state {
        case .succeeded: Palette.ok
        case .failed: Palette.flag
        default: Palette.fg
        }
    }

    private var title: String {
        switch state {
        case .idle: "Work on this"
        case .running: "Starting"
        case .succeeded: "Started"
        case .failed: AgentWords.notStarted
        }
    }

    private var context: ActionCopy.Context { .init() }

    /// Life saved the goal he saw (its `goal_saved` passed).
    private var isGoalSaved: Bool { state.steps.contains { $0.id == "goal_saved" && $0.passedAt != nil } }

    private var form: some View {
        VStack(alignment: .leading, spacing: 16) {
            Caps("The goal, in your words")
            DictationField(prompt: "Goal", text: $goal, axis: .vertical).font(.quote).foregroundStyle(Palette.fg)
                .lineLimit(2...).padding(16).background(Palette.card, in: .rect(cornerRadius: Metrics.Radius.passage))
            Caps("Who works on it")
            SegmentedChoice(choices: RuntimeName.offered, selection: $runtimeName, title: \.name)
                .onChange(of: runtimeName) { model = nil }
            if let models = runtimeName?.models, !models.isEmpty {
                Caps("Model")
                HStack(spacing: 8) {
                    ForEach(models, id: \.id) { option in
                        FilterChip(name: option.name, isOn: model == option) {
                            model = model == option ? nil : option
                        }
                    }
                }
            }
            Text("Pick none and it uses its usual one.").font(.small).foregroundStyle(Palette.faint)
            Text(
                "It starts with a plan for you to approve: nothing happens before you say Go. Nothing is ever sent, paid or booked without your tap."
            )
            .font(.body15).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The answers of each state, in the bottom bar: Start; Starting…; Done; Try again (and the other program) or Close.
    @ViewBuilder private var buttons: some View {
        VStack(spacing: 10) {
            switch state {
            case .idle:
                Button("Start") { start() }.buttonStyle(.pill(.filled))
                    .disabled(goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).offWhileOutOfReach()
            case .running:
                Button {
                } label: {
                    Text("Starting…")
                }.buttonStyle(.pill(.quiet, isBusy: true))
            case .succeeded: Button("Done") { dismiss() }.buttonStyle(.pill(.filled))
            case .failed(let failure, _):
                if failure.canTryAgain {
                    Button("Try again") { start() }.buttonStyle(.pill(.filled))
                    if let other = RuntimeName.offered.first(where: { $0 != runtimeName }), runtimeName != nil {
                        Button("Use \(other.name)") {
                            runtimeName = other; model = nil; start()
                        }.buttonStyle(.pill(.quiet))
                    }
                } else {
                    Button("Close") { dismiss() }.buttonStyle(.pill(.filled))
                }
            }
        }
    }

    private var goalLine: some View {
        Text(goal).font(.quote).foregroundStyle(Palette.fg).fixedSize(
            horizontal: false, vertical: true)
    }

    private var progress: some View {
        VStack(alignment: .leading, spacing: 16) {
            goalLine
            CheckLines(lines: ActionCopy.lines(state, context)).padding(16).frame(
                maxWidth: .infinity, alignment: .leading
            )
            .background(Palette.card, in: .rect(cornerRadius: Metrics.Radius.card))
            LimitNote(state: state) {
                "Each line is checked for real, " + ($0 ?? "in a few seconds")
                    + ". If one fails you are told here, and nothing is left half started."
            }
            .font(.body15).foregroundStyle(Palette.muted)
        }
    }

    private func started(_ proof: ActionProof) -> some View {
        var link: URL?
        var took = runtimeName
        if case .agent(let result) = proof {
            link = result.stages?.compactMap(\.link).last.flatMap(URL.init(string:))
            // The runtime that took it: his pick, else its default.
            took = result.runtime.flatMap(RuntimeName.init(rawValue:)) ?? took
        }
        return VStack(alignment: .leading, spacing: 16) {
            goalLine
            CheckLines(lines: ActionCopy.lines(state, context)).padding(16).frame(
                maxWidth: .infinity, alignment: .leading
            )
            .background(Palette.card, in: .rect(cornerRadius: Metrics.Radius.card))
            Text(
                "It is writing its plan. Its plan comes to your inbox. Nothing else happens before you say Go."
            )
            .font(.body15).foregroundStyle(Palette.muted)
            if let link {
                TextLink("Open in \(took?.name ?? "its app")", to: .outside) { openURL(link) }
            }
        }
    }

    private func notStarted(_ failure: ActionFailure) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            goalLine
            CheckLines(lines: ActionCopy.lines(state, context)).padding(16).frame(
                maxWidth: .infinity, alignment: .leading
            )
            .background(Palette.card, in: .rect(cornerRadius: Metrics.Radius.card))
            Text(
                failure.mayHaveHappened
                    ? "Check the matter before starting again: an agent may be running."
                    : "Nothing was started, and nothing is running in the background."
                        + (isGoalSaved ? " Your goal is kept." : "")
            )
            .font(.body15).foregroundStyle(Palette.muted)
        }
    }

    private func start() {
        let runtime = runtimeName?.rawValue
        let model = model
        Task {
            await life.startAgent(
                on: matter.row.id, goal: goal.trimmingCharacters(in: .whitespacesAndNewlines), runtime: runtime,
                model: model?.id)
        }
    }
}
