import LifeConnector
import SwiftUI

/// His "Wrong…" on a card of Life's: what is true, in his words, and his tick on a report to the developer (he sees it
/// first, as a card of its own). "Let the caretaker handle it" goes through the one answer path (`LifeStore.answer`,
/// `.complaint`); the sheet closes only on Life's complaint receipt. Anything else keeps his words and tick for Try
/// again, which resends the press as first sent, so Life resumes it under its key and never asks the caretaker twice.
struct WrongSheet: View {
    let check: Check

    @Environment(LifeStore.self) private var life
    @Environment(\.dismiss) private var dismiss
    @State private var words = ""
    @State private var report = false
    /// The press as first sent (the card's seal may move after it): resent while his words and tick are unchanged.
    @State private var sent: AnswerRequest?
    @FocusState private var isWriting: Bool

    private var state: ActionState<ActionProof> { life.state(of: .complaint(ref: check.ref)) }

    private var request: AnswerRequest? {
        let trimmed = words.trimmingCharacters(in: .whitespacesAndNewlines)
        if let sent, sent.note == trimmed, sent.value?.report == report { return sent }
        return check.complaint(words: words, report: report)
    }

    private var isReceived: Bool {
        if case .succeeded = state { return true }
        return false
    }

    /// Sending or received: nothing of his can change any more.
    private var isLocked: Bool { state.isRunning || isReceived }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetHeader(title: "What's wrong?") { dismiss() }
            // The thing he pressed, small: the card's question on one line.
            Text(check.question).font(.body15).foregroundStyle(Palette.fg).lineLimit(1)
                .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.m)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
                .padding(.top, Metrics.Spacing.l)
            Group {
                TextField("Say what is true…", text: $words, axis: .vertical)
                    .font(.quote).foregroundStyle(Palette.fg).lineLimit(3...8).focused($isWriting)
                    .padding(Metrics.Spacing.l)
                    .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
                    .padding(.top, Metrics.Spacing.m)
                Spacer(minLength: Metrics.Spacing.l)
                reportBox
            }
            .disabled(isLocked)
            if case .failed(let failure, _) = state {
                Text((failure.isSameTap ? "Your Mac did not answer." : failure.reason) + " Your words are kept.")
                    .font(.small).foregroundStyle(Palette.flag).padding(.top, Metrics.Spacing.l).appears()
            }
            button.padding(.top, Metrics.Spacing.l)
        }
        .padding(Metrics.gutter)
        .background(Palette.sheet)
        .motion(Motion.standard, value: state)
        // His words by voice or keyboard first: the keyboard is up, its microphone one tap away.
        .onAppear { isWriting = true }
        .task(id: isReceived) {
            guard isReceived else { return }
            try? await Task.sleep(for: .seconds(0.6))
            dismiss()
        }
        .onDisappear { life.forget(.complaint(ref: check.ref)) }
    }

    private var reportBox: some View {
        Button {
            report.toggle()
        } label: {
            HStack(alignment: .top, spacing: Metrics.Spacing.m) {
                Image(systemName: report ? "checkmark.square.fill" : "square.fill").imageScale(.large)
                    .foregroundStyle(report ? Palette.fg : Color.fillTint)
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs / 2) {
                    Text("Send an anonymized report to the developer").font(.body15).foregroundStyle(
                        isLocked ? Palette.muted : Palette.fg)
                    Text("You see the report before anything is sent.").font(.small).foregroundStyle(Palette.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(report ? "On" : "Off")
    }

    @ViewBuilder private var button: some View {
        switch state {
        case .running:
            Button("Sending to the caretaker…") {}.buttonStyle(.pill(.filled, isBusy: true))
        case .succeeded:
            Button("The caretaker has it") {}.buttonStyle(.pill(.done)).allowsHitTesting(false)
        default:
            Button(state == .idle ? "Let the caretaker handle it" : "Try again") {
                guard let request else { return }
                sent = request
                Task { await life.answer(request) }
            }
            .buttonStyle(.pill(.filled)).lineLimit(1).minimumScaleFactor(0.75)
            .disabled(request == nil)
        }
    }
}
