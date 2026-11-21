import LifeConnector
import SwiftUI

/// His "Wrong…" on a card of Life's: what is true, in his words, and his tick on a report to the developer (he sees it
/// first, as a card of its own). Hosted with the asks' sheets (`askSheets`), above the reads; what he wrote and the press
/// he sent are the store's draft (`LifeStore.complaints`), so a refresh, the card leaving or Close loses none of it.
/// "Let the caretaker handle it" sends through the one answer path (`LifeStore.complain`); the sheet closes only on Life's
/// receipt for that press, and anything else keeps his words and tick for Try again, which resends that press.
struct WrongSheet: View {
    let ref: String

    @Environment(LifeStore.self) private var life
    @Environment(\.dismiss) private var dismiss
    @FocusState private var isWriting: Bool

    private var draft: ComplaintDrafts.Draft? { life.complaints[ref] }
    private var state: ActionState<ActionProof> { life.state(of: .complaint(ref: ref)) }
    private var receipt: String? { draft?.receipt }
    /// Sending, or received: nothing of his can change any more.
    private var isLocked: Bool { state.isRunning || receipt != nil }

    private var failure: ActionFailure? {
        if receipt == nil, case .failed(let failure, _) = state { return failure }
        return nil
    }

    private var words: Binding<String> {
        Binding(get: { life.complaints[ref]?.words ?? "" }, set: { life.complaints[ref]?.words = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetHeader(title: "What's wrong?") { dismiss() }
            if let draft {
                // The thing he pressed, small: the card's question as he opened the sheet on it, which the press seals.
                Text(draft.check.question).font(.body15).foregroundStyle(Palette.fg).lineLimit(1)
                    .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.m)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
                    .padding(.top, Metrics.Spacing.l)
                Group {
                    DictationField(prompt: "Say what is true…", text: words, axis: .vertical, focused: $isWriting)
                        .font(.quote).foregroundStyle(Palette.fg).lineLimit(3...8)
                        .padding(Metrics.Spacing.l)
                        .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
                        .padding(.top, Metrics.Spacing.m)
                    Spacer(minLength: Metrics.Spacing.l)
                    reportBox(isOn: draft.report)
                }
                .disabled(isLocked)
                if let failure {
                    Text((failure.isSameTap ? "Your Mac did not answer." : failure.reason) + " Your words are kept.")
                        .font(.small).foregroundStyle(Palette.flag).padding(.top, Metrics.Spacing.l).appears()
                }
                button(draft).padding(.top, Metrics.Spacing.l)
            }
        }
        .padding(Metrics.gutter)
        .background(Palette.sheet)
        .motion(Motion.standard, value: state)
        // His words by voice or keyboard first: the keyboard is up, its microphone one tap away.
        .onAppear { isWriting = true }
        // The receipt for his press: said, then the sheet closes. No draft (another Life was paired): nothing to show.
        .task(id: receipt) {
            guard receipt != nil, (try? await Task.sleep(for: .seconds(0.6))) != nil else { return }
            dismiss()
        }
        .onChange(of: draft == nil) { _, isGone in if isGone { dismiss() } }
        // Closed untouched, it leaves nothing: the next sheet opens on the card as it is then.
        .onDisappear { life.complaints.close(ref) }
    }

    private func reportBox(isOn: Bool) -> some View {
        Button {
            life.complaints[ref]?.report.toggle()
        } label: {
            HStack(alignment: .top, spacing: Metrics.Spacing.m) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square.fill").imageScale(.large)
                    .foregroundStyle(isOn ? Palette.fg : Color.fillTint)
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
        .accessibilityValue(isOn ? "On" : "Off")
    }

    @ViewBuilder private func button(_ draft: ComplaintDrafts.Draft) -> some View {
        if receipt != nil {
            Button("The caretaker has it") {}.buttonStyle(.pill(.done)).allowsHitTesting(false)
        } else if state.isRunning {
            Button("Sending to the caretaker…") {}.buttonStyle(.pill(.filled, isBusy: true))
        } else {
            Button(failure == nil ? "Let the caretaker handle it" : "Try again") {
                Task { await life.complain(ref) }
            }
            .buttonStyle(.pill(.filled)).lineLimit(1).minimumScaleFactor(0.75)
            .disabled(draft.check.complaint(words: draft.words, report: draft.report) == nil)
            .offWhileOutOfReach()
        }
    }
}
