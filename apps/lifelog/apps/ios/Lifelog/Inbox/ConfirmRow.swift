import LifeConnector
import SwiftUI

/// One of Life's own questions as a row: its question and where it came from, and, when two of its options need nothing
/// more than a tap, those two as buttons. A tap elsewhere on the row is the caller's (it opens the whole ask).
struct ConfirmRow: View {
    let check: Check
    /// His tap on one of the two buttons: the caller says whether it goes at once or is held for Undo.
    let choose: (Check.Option) -> Void

    @Environment(LifeStore.self) private var life

    var body: some View {
        let state = life.state(of: .answer(ref: check.ref))
        VStack(alignment: .leading, spacing: 0) {
            Row(title: check.question, detail: check.evidence?.from, state: rowState(state))
            // Under the question, not beside it: the answers are as long as Life words them.
            if !state.isRunning && !plainOptions.isEmpty {
                buttons.padding(.horizontal, Metrics.Spacing.l).padding(.bottom, Metrics.Spacing.l)
            }
        }
        .motion(Motion.standard, value: state)
    }

    /// The options that take nothing more, when there are exactly two: the others need the whole ask.
    private var plainOptions: [Check.Option] {
        let plain = check.options.filter { $0.takes == nil }
        return plain.count == 2 ? plain : []
    }

    @ViewBuilder private var buttons: some View {
        HStack(spacing: 8) {
            ForEach(plainOptions, id: \.id) { option in
                RowButton(title: option.label) { choose(option) }
            }
        }
    }

    private func rowState(_ state: ActionState<ActionProof>) -> RowState {
        switch state {
        case .running: .saving
        case .failed(let failure, _): .refused(failure.reason)
        case .idle, .succeeded: .known
        }
    }
}
