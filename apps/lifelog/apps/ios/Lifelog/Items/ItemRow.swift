import LifeConnector
import SwiftUI

/// One ask of his thread as the design system's item: Life gives the state (`ThreadAsk.State`), the phone adds only
/// "queued" (his answer waits for Life to be back). Unfolded, an ask he can answer is an `AskCard`; one he cannot is
/// its question; a send he may undo is a `SentLine`.
struct ItemRow: View {
    let ask: ThreadAsk
    @Environment(LifeStore.self) private var life
    @State private var isOpen = false
    @State private var words = ""
    @State private var isConfirmingUndo = false
    /// The answer he tapped last: the one that shows its spinner while Life works.
    @State private var tapped: String?
    /// The option that takes a person, while his directory's picker is open.
    @State private var pickingFor: String?

    private var key: LifeStore.ActionKey { .answer(ref: ask.ref) }
    private var action: ActionState<ActionProof> { life.state(of: key) }
    private var isQueued: Bool { life.isQueued(ask.ref) }

    private var state: ItemState {
        if isQueued { return .queued }
        return switch ask.state {
        case .needsYou, .unknown: .needsYou
        case .later: .later
        case .underWay: .underWay(progress: 0, estimate: nil)
        case .waitingOnSomeone: .waitingOnSomeone
        case .settled: .settled
        case .outdated: .outdated
        }
    }

    var body: some View {
        ThreadItemRow(
            title: ask.title, state: state, icon: ask.check?.draft == nil ? "circle.dashed" : "bubble.left",
            isOpen: isOpen, ref: ask.ref,
            toggle: { withAnimation(Motion.standard) { isOpen.toggle() } }
        ) {
            detail.transition(Motion.appears)
        }
        .sheet(item: $pickingFor) { option in
            PersonPicker { party in
                Task { await life.answer(AnswerRequest(ref: ask.ref, options: [option], person: party.ref)) }
            }
            .padding(Metrics.Spacing.l).presentationDetents([.medium, .large])
        }
        .onAppear { isOpen = life.focused == ask.ref }
        .onChange(of: life.focused) { if life.focused == ask.ref { isOpen = true } }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            if let check = ask.check, ask.isAnswerable, !isQueued {
                card(check)
            } else if !ask.question.isEmpty {
                Text(ask.question).font(.line).foregroundStyle(Palette.muted)
            }
            if case .failed(let failure, _) = action {
                Text(failure.reason).font(.line).foregroundStyle(Palette.flag).accessibilityIdentifier(
                    AID.askFailure(ask.ref))
            }
            if ask.undoLine != nil { undo }
        }
    }

    /// The options of the card that are answers: a put-off ("Not now") is Later, which every ask offers.
    private func answers(of check: Check) -> [Check.Option] {
        check.options.filter { $0.icon != .later && $0.id != "not-now" }
    }

    private func card(_ check: Check) -> some View {
        let options = answers(of: check)
        let label = { (id: String?) in options.first { $0.id == id }?.label }
        let taking = options.contains { $0.takes == .note || $0.takes == .personOrName }
        return AskCard(
            question: ask.question, check: check, answers: options.map(\.label),
            recommended: label(check.recommended), busy: action.isRunning ? tapped : nil,
            taking: taking ? $words : nil,
            disabled: Set(
                options.filter { ($0.takes == .note || $0.takes == .personOrName) && words.isEmpty }.map(\.label)),
            identify: { l in options.first { $0.label == l }.map { AID.askAnswer(ask.ref, $0.id) } },
            hasFailed: { if case .failed = action { true } else { false } }(),
            say: { l in
                tapped = l
                if l == "Later" {
                    Task { await life.later(ask.ref) }
                } else if let option = options.first(where: { $0.label == l }), option.takes == .person {
                    pickingFor = option.id
                } else if let option = options.first(where: { $0.label == l }) {
                    Task {
                        await life.answer(
                            AnswerRequest(
                                ref: ask.ref, options: [option.id], note: option.takes == .note ? words : nil,
                                name: option.takes == .personOrName ? words : nil))
                    }
                }
            }, isInItem: true)
    }

    /// His Undo: first what the other side will see, when Life says there is something to see, then the deletion.
    private var undo: some View {
        let warning = ask.undoLine.flatMap { $0.isEmpty ? nil : $0 }
        return SentLine(
            phase: action.isRunning ? .undoing : isConfirmingUndo ? .confirming(warning ?? "") : .sent(canUndo: true),
            undo: {
                if warning != nil, !isConfirmingUndo {
                    isConfirmingUndo = true
                } else {
                    Task { await life.undo(ask.ref) }
                }
            },
            keep: { isConfirmingUndo = false }, undoID: AID.askUndo(ask.ref))
    }
}
