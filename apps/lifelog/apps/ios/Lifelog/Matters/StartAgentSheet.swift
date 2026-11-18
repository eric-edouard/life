import LifeConnector
import SwiftUI

/// "Work on this": his goal in his words, who works on it, then the start as the desk reports it, stage by stage.
/// The phone has no default of its own: a runtime is sent only when he picks one.
struct StartAgentSheet: View {
    let matter: Matter

    @Environment(LifeStore.self) private var life
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var goal = ""
    @State private var provider: Provider?

    private var state: ActionState<ActionProof> { life.state(of: .start(matter: matter.row.id)) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SheetHeader(title: title) { dismiss() }
                switch state {
                case .idle: form
                case .running: progress
                case .succeeded(let proof, _): started(proof)
                case .failed(let failure, _): notStarted(failure)
                }
            }
            .padding(20)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Palette.sheet)
        .presentationDetents([.large])
        .onAppear { if goal.isEmpty { goal = matter.row.goal?.text ?? "" } }
    }

    private var title: String {
        switch state {
        case .idle: "Work on this"
        case .running: "Starting"
        case .succeeded: "Started"
        case .failed: "Not started"
        }
    }

    private var context: ActionCopy.Context { .init(provider: provider?.name ?? "The agent") }

    private var form: some View {
        VStack(alignment: .leading, spacing: 16) {
            Caps("The goal, in your words")
            TextField("Goal", text: $goal, axis: .vertical).font(.manrope(19, weight: 500)).foregroundStyle(Palette.fg)
                .lineLimit(2...6).padding(16).background(Palette.card, in: .rect(cornerRadius: 20))
            Caps("Who works on it")
            HStack(spacing: 8) {
                ForEach(Provider.offered, id: \.self) { option in
                    Button {
                        provider = provider == option ? nil : option
                    } label: {
                        Label(option.name, systemImage: "sparkle").font(.manrope(16, weight: 600))
                            .foregroundStyle(provider == option ? Palette.on : Palette.fg)
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(provider == option ? Palette.fg : Color.fillTint, in: .capsule)
                    }
                    .buttonStyle(.plain).accessibilityAddTraits(provider == option ? .isSelected : [])
                }
            }
            Text("Pick none and the desk uses its own default.").font(.small).foregroundStyle(Palette.faint)
            Text(
                "Its first step is a plan card: nothing happens before you say Go. Nothing is ever sent, paid or booked without your tap."
            )
            .font(.body15).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            Button("Start") { start() }.buttonStyle(.pill(.filled))
                .disabled(goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private var goalLine: some View {
        Text(goal).font(.manrope(19, weight: 650)).foregroundStyle(Palette.fg).fixedSize(
            horizontal: false, vertical: true)
    }

    private var progress: some View {
        VStack(alignment: .leading, spacing: 16) {
            goalLine
            CheckLines(lines: ActionCopy.lines(state, context)).padding(16).frame(
                maxWidth: .infinity, alignment: .leading
            )
            .background(Palette.card, in: .rect(cornerRadius: 20))
            Text(
                "Each line is checked for real, in a few seconds. If one fails you are told here, and nothing is left half started."
            )
            .font(.body15).foregroundStyle(Palette.muted)
            Button {
            } label: {
                Text("Starting…")
            }.buttonStyle(.pill(.quiet)).disabled(true)
        }
    }

    private func started(_ proof: ActionProof) -> some View {
        var link: URL?
        if case .agent(let result) = proof { link = result.stages?.compactMap(\.link).last.flatMap(URL.init(string:)) }
        return VStack(alignment: .leading, spacing: 16) {
            goalLine
            CheckLines(lines: ActionCopy.lines(state, context)).padding(16).frame(
                maxWidth: .infinity, alignment: .leading
            )
            .background(Palette.card, in: .rect(cornerRadius: 20))
            Text(
                "It is writing its plan. The plan reaches you as a card, with a push. Nothing else happens before you say Go."
            )
            .font(.body15).foregroundStyle(Palette.muted)
            if let link {
                Button {
                    openURL(link)
                } label: {
                    Text("Open in \(provider?.name ?? "its app") \(Image(systemName: "arrow.up.right"))")
                }
                .buttonStyle(.pill(.quiet))
            }
            Button("Done") { dismiss() }.buttonStyle(.pill(.filled))
        }
    }

    private func notStarted(_ failure: ActionFailure) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            goalLine
            CheckLines(lines: ActionCopy.lines(state, context)).padding(16).frame(
                maxWidth: .infinity, alignment: .leading
            )
            .background(Palette.card, in: .rect(cornerRadius: 20))
            Text(
                failure.mayHaveHappened
                    ? "Check the matter before starting again: an agent may be running."
                    : "Nothing was started, and nothing is running in the background. Your goal is kept."
            )
            .font(.body15).foregroundStyle(Palette.muted)
            if failure.retry == .allowed && !failure.mayHaveHappened {
                Button("Try again") { start() }.buttonStyle(.pill(.filled))
                if let other = Provider.offered.first(where: { $0 != provider }), provider != nil {
                    Button("Use \(other.name)") {
                        provider = other; start()
                    }.buttonStyle(.pill(.quiet))
                }
            } else {
                Button("Close") { dismiss() }.buttonStyle(.pill(.filled))
            }
        }
    }

    private func start() {
        let runtime = provider?.rawValue
        Task {
            await life.startAgent(
                on: matter, goal: goal.trimmingCharacters(in: .whitespacesAndNewlines), runtime: runtime)
        }
    }
}
