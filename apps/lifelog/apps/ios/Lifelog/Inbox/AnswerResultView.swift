import LifeConnector
import SwiftUI

/// What he tapped, kept while it runs and after: the card as it was (the inbox no longer holds it once answered), the
/// request to repeat, and where it stood in the list.
struct Taken: Equatable {
    let check: Check
    let request: AnswerRequest
    let position: Int
    let total: Int
    let runtimeName: RuntimeName?

    var key: LifeStore.ActionKey { .answer(ref: check.ref) }
    var context: ActionCopy.Context {
        .init(
            to: check.draft?.to, channel: check.draft?.channel,
            asker: check.asker.caseInsensitiveCompare("life") == .orderedSame
                ? "Life" : (runtimeName?.name ?? check.asker), runtimeName: runtimeName?.name)
    }
}

/// The card after his tap, every state of it: sending, sent, saved, not sent. Its lines are the action's own steps, so
/// nothing here says a thing happened that Life has not reported.
struct AnswerResultView: View {
    let taken: Taken
    let state: ActionState<ActionProof>
    /// The question of the card that comes next, when one is waiting.
    let next: String?
    let retry: () -> Void
    let keepForLater: () -> Void
    let nextCard: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                switch state {
                case .succeeded(let proof, _): done(proof)
                case .failed(let failure, _): failed(failure)
                case .idle, .running: working
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 16)
            .readingWidth()
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            buttons.padding(.horizontal, 20).padding(.bottom, 8).readingWidth().background(Palette.bg)
        }
    }

    private var isSend: Bool { taken.check.draft != nil }
    private var lines: [CheckLine] { ActionCopy.lines(state, taken.context) }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            Caps("\(taken.position) of \(taken.total)", color: Palette.muted)
            HStack(spacing: 8) {
                chip(taken.context.asker ?? "Life", "sparkle", tint: Palette.ai)
                if let matter = taken.check.matter { chip(matter.name, "list.bullet.indent", tint: Palette.fg) }
            }
        }
    }

    private func chip(_ text: String, _ symbol: String, tint: Color) -> some View {
        Label(text, systemImage: symbol).font(.chip).foregroundStyle(tint)
            .lineLimit(1).padding(.horizontal, 14).frame(minHeight: 40).background(Color.fillTint, in: .capsule)
    }

    // MARK: States

    @ViewBuilder private var working: some View {
        header
        Text(taken.check.title).font(.cardHeadline).foregroundStyle(Palette.fg)
        Text(taken.check.question).font(.cardQuestion).foregroundStyle(Palette.fg).lit()
        if let draft = taken.check.draft { DraftBlock(draft: draft) }
        CheckLines(lines: lines.isEmpty ? [CheckLine(id: "asking", text: "Asking Life", mark: .running)] : lines)
            .padding(.top, 8)
    }

    @ViewBuilder private func done(_ proof: ActionProof) -> some View {
        header
        Text(isSend ? "Sent." : doneWord).font(.statusWord).foregroundStyle(Palette.fg).lit().padding(.top, 12)
        Text(summary(proof)).font(.lead).foregroundStyle(Palette.muted)
        CheckLines(lines: lines.filter { $0.id != "left_inbox" }).padding(.top, 8)
        if let changed = counts(proof) {
            Text(changed).font(.body15).foregroundStyle(Palette.muted)
        }
        if let next {
            Text("Next: \(Text(next).foregroundStyle(Palette.fg))").font(.body15).foregroundStyle(Palette.faint)
                .padding(.top, 8)
        }
    }

    @ViewBuilder private func failed(_ failure: ActionFailure) -> some View {
        header
        Text(failedWord(failure)).font(.statusWord).foregroundStyle(Palette.flag).padding(.top, 12)
        Text(failedLine(failure)).font(.lead).foregroundStyle(Palette.muted)
        CheckLines(lines: lines).padding(.top, 8)
    }

    private var doneWord: String {
        switch taken.check.group {
        case .voice: "Named."
        case .ending: "Noted."
        case .card: "Done."
        case .name, .guessedPerson: "Saved."
        case .decision, .unknown: "Answered."
        }
    }

    private func summary(_ proof: ActionProof) -> String {
        guard case .answered(let result) = proof else { return "" }
        if let send = result.send {
            let to = [taken.check.draft?.to, send.channel.map(ActionCopy.channel)].compactMap(\.self)
            let when = send.at.map { ", at \($0.formatted(.dateTime.hour().minute()))" } ?? ""
            return "To \(to.joined(separator: " on "))\(when)."
        }
        if taken.request.options.isEmpty { return "Your words went to \(taken.context.asker ?? "the asker")." }
        let label = taken.check.options.first { taken.request.options.contains($0.id) }?.label
        return label.map { "\($0)." } ?? "Your answer is recorded."
    }

    private func counts(_ proof: ActionProof) -> String? {
        guard case .answered(let result) = proof, let changed = result.changed else { return nil }
        let parts = [
            changed.voices.map { "\($0) clip\($0 == 1 ? "" : "s")" },
            changed.conversations.map { "\($0) conversation\($0 == 1 ? "" : "s")" },
        ].compactMap(\.self)
        return parts.isEmpty ? nil : parts.joined(separator: " and ") + " now carry the name"
    }

    private func failedWord(_ failure: ActionFailure) -> String {
        if failure.mayHaveHappened { return isSend ? "May have gone." : "Check first." }
        return isSend ? "Not sent." : "Not saved."
    }

    private func failedLine(_ failure: ActionFailure) -> String {
        if failure.mayHaveHappened { return "Check before answering again. The card stays here." }
        return isSend ? "Nothing went out. The card stays here." : "Nothing was recorded. The card stays here."
    }

    // MARK: Buttons

    @ViewBuilder private var buttons: some View {
        VStack(spacing: 8) {
            switch state {
            case .succeeded:
                Button(next == nil ? "Done" : "Next card", action: nextCard).buttonStyle(.pill(.filled))
            case .failed(let failure, _):
                if failure.retry == .allowed && !failure.mayHaveHappened {
                    Button("Try again", action: retry).buttonStyle(.pill(.filled))
                    Button("Keep it for later", action: keepForLater).buttonStyle(.pill(.quiet))
                    Text(
                        isSend
                            ? "Trying again sends the same text once. It is never sent twice."
                            : "Trying again repeats the same answer once."
                    )
                    .font(.small).foregroundStyle(Palette.faint).multilineTextAlignment(.center)
                } else {
                    Button("Keep it for later", action: keepForLater).buttonStyle(.pill(.filled))
                }
            case .idle, .running:
                Button {
                } label: {
                    Text(isSend ? "Sending…" : "Saving…")
                }.buttonStyle(.pill(.quiet)).disabled(true)
                if isSend {
                    LimitNote(limit: state.limit) {
                        "Stays on this card until \(ActionCopy.channel(taken.check.draft?.channel)) answers"
                            + ($0.map { ", \($0)." } ?? ".")
                    }
                    .font(.small).foregroundStyle(Palette.faint).multilineTextAlignment(.center)
                }
            }
        }
    }
}
