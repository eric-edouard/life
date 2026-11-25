import LifeConnector
import SwiftUI

/// One ask of his thread, as a row that unfolds. Its state is Life's (`ThreadAsk.State`); the phone adds only
/// "queued" (his answer waits for Life to be back). Answers are icons; the one word on a button is Later.
struct ItemRow: View {
    let ask: ThreadAsk
    @Environment(LifeStore.self) private var life
    @State private var isOpen = false
    @State private var words = ""

    private var key: LifeStore.ActionKey { .answer(ref: ask.ref) }
    private var action: ActionState<ActionProof> { life.state(of: key) }
    private var isQueued: Bool { life.isQueued(ask.ref) }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            Button {
                withAnimation(Motion.standard) { isOpen.toggle() }
            } label: {
                HStack(spacing: Metrics.Spacing.m) {
                    Text(ask.title).font(.rowTitle).foregroundStyle(ask.state == .outdated ? Palette.faint : Palette.fg)
                        .strikethrough(ask.state == .outdated).multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    mark
                }
                .frame(minHeight: Metrics.tapTarget).contentShape(.rect)
            }
            .buttonStyle(.plain).accessibilityIdentifier(AID.askRow(ask.ref))
            if isOpen { detail.transition(Motion.appears) }
            Hairline()
        }
        .onAppear { isOpen = life.focused == ask.ref }
        .onChange(of: life.focused) { if life.focused == ask.ref { isOpen = true } }
    }

    /// The state, drawn small at the row's end.
    @ViewBuilder private var mark: some View {
        if isQueued {
            Image(systemName: "arrow.up.circle").foregroundStyle(Palette.muted).accessibilityLabel(
                "Goes when Life is back"
            ).accessibilityIdentifier(AID.askQueued(ask.ref))
        } else {
            switch ask.state {
            case .needsYou:
                Image(systemName: "circle.fill").font(.metaStrong).foregroundStyle(Palette.flag).accessibilityLabel(
                    "Needs you")
            case .later: Image(systemName: "clock").foregroundStyle(Palette.muted).accessibilityLabel("Later")
            case .underWay: Spinner(size: .small).foregroundStyle(Palette.ai).accessibilityLabel("Under way")
            case .waitingOnSomeone:
                Image(systemName: "hourglass").foregroundStyle(Palette.muted).accessibilityLabel("Waiting on someone")
            case .settled:
                Image(systemName: "checkmark").foregroundStyle(Palette.ok).accessibilityLabel("Settled")
                    .accessibilityIdentifier(AID.askSettled(ask.ref))
            case .outdated, .unknown: EmptyView()
            }
        }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            if !ask.question.isEmpty { Text(ask.question).foregroundStyle(Palette.muted) }
            if let text = ask.check?.draft?.text { Text(text).font(.quote).padding(.leading, Metrics.Spacing.m) }
            if let check = ask.check, ask.isAnswerable, !isQueued { answers(check) }
            if case .failed(let failure, _) = action {
                Text(failure.reason).font(.line).foregroundStyle(Palette.flag).accessibilityIdentifier(
                    AID.askFailure(ask.ref))
            }
            if ask.undoLine != nil { undo }
        }
    }

    private func answers(_ check: Check) -> some View {
        let taking = check.options.contains { $0.takes == .note || $0.takes == .personOrName }
        return VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            if taking {
                TextField("", text: $words, axis: .vertical).padding(Metrics.Spacing.m)
                    .background(Palette.tint, in: .rect(cornerRadius: Metrics.Radius.control))
            }
            HStack(spacing: Metrics.Spacing.s) {
                ForEach(check.options.filter { $0.takes != .person }, id: \.id) { option in answer(option, of: check) }
                Button("Later") { Task { await life.later(ask.ref) } }.buttonStyle(.pill(.quiet, size: .compact))
            }
        }
    }

    private func answer(_ option: Check.Option, of check: Check) -> some View {
        let isDone: Bool = { if case .succeeded = action { true } else { false } }()
        let request = AnswerRequest(
            ref: ask.ref, options: [option.id], note: option.takes == .note ? words : nil,
            name: option.takes == .personOrName ? words : nil)
        return Button {
            Task { await life.answer(request) }
        } label: {
            Image(systemName: isDone ? "checkmark" : option.icon?.symbol ?? "checkmark")
        }
        .buttonStyle(
            .pill(
                isDone ? .done : option.id == check.recommended ? .filled : .quiet, size: .compact,
                isBusy: action.isRunning)
        )
        .accessibilityLabel(option.label).accessibilityIdentifier(AID.askAnswer(ask.ref, option.id))
        .disabled((option.takes != nil && words.isEmpty) || action.isRunning)
    }

    private var undo: some View {
        Button {
            Task { await life.undo(ask.ref) }
        } label: {
            Image(systemName: "arrow.uturn.backward")
        }
        .buttonStyle(.pill(.quiet, size: .compact, isBusy: action.isRunning))
        .accessibilityLabel("Undo").accessibilityHint(ask.undoLine ?? "").accessibilityIdentifier(AID.askUndo(ask.ref))
    }
}
