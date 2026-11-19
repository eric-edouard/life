import LifeConnector
import SwiftUI

/// One of Life's own questions as a row: its question and where it came from, and, when two of its options need nothing
/// more than a tap, those two as buttons. With `open`, a tap on the row opens the whole ask and an answer is held four
/// seconds for Undo, drawn here; without it the caller sends at once.
struct QuestionRow: View {
    let check: Check
    var open: (() -> Void)?
    /// His tap on one of the two buttons.
    let choose: (Check.Option) -> Void

    @Environment(LifeStore.self) private var life

    var body: some View {
        if let held = life.held[check.ref] {
            Row(title: held.label) { RowButton(title: "Undo") { life.undo(check.ref) } }
        } else {
            asking
        }
    }

    private var asking: some View {
        let state = life.state(of: .answer(ref: check.ref))
        return VStack(alignment: .leading, spacing: 0) {
            if let open {
                Button(action: open) { question(state) }.buttonStyle(.plain)
            } else {
                question(state)
            }
            // Under the question, not beside it: the answers are as long as Life words them.
            if isOpen(state) && !plainOptions.isEmpty {
                buttons.padding(.horizontal, Metrics.Spacing.l).padding(.bottom, Metrics.Spacing.l)
            }
        }
        .motion(Motion.standard, value: state)
    }

    /// The buttons show while nothing was sent, or when it failed: never after it went.
    private func isOpen(_ state: ActionState<ActionProof>) -> Bool {
        switch state {
        case .idle, .failed: true
        case .running, .succeeded: false
        }
    }

    private func question(_ state: ActionState<ActionProof>) -> some View {
        Row(title: check.question, detail: check.evidence?.from, state: rowState(state))
    }

    /// The options that take nothing more, when there are exactly two: the others need the whole ask.
    private var plainOptions: [Check.Option] {
        let plain = check.options.filter { $0.takes == nil }
        return plain.count == 2 ? plain : []
    }

    @ViewBuilder private var buttons: some View {
        // Two buttons side by side, or one above the other when a larger text size leaves no room.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { choices }
            VStack(spacing: 8) { choices }
        }
    }

    @ViewBuilder private var choices: some View {
        ForEach(plainOptions, id: \.id) { option in
            RowButton(title: option.label) { choose(option) }
        }
    }

    private func rowState(_ state: ActionState<ActionProof>) -> RowState {
        switch state {
        case .running: .saving
        case .failed(let failure, _): .refused(failure.reason)
        case .succeeded: .saved
        case .idle: .known
        }
    }
}
