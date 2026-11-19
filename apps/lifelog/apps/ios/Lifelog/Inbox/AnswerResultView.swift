import LifeConnector
import SwiftUI

/// What he tapped, kept while it runs and after: the card as it was (the inbox no longer holds it once answered), the
/// request to repeat, and the card that follows it.
struct Taken: Equatable {
    let check: Check
    let request: AnswerRequest
    /// The card after this one in the inbox when he tapped, so the result still knows it once the inbox let it go.
    let nextRef: String?
    let runtimeName: RuntimeName?

    var key: LifeStore.ActionKey { .answer(ref: check.ref) }
    /// A new matter whose goal he changed is still waiting for Start or Dismiss.
    var staysOpen: Bool { check.group == .newMatter && request.options == ["edit-goal"] }
    var isSend: Bool { check.draft != nil }
    var isStart: Bool { check.group == .newMatter && request.options == ["start"] }
    var context: ActionCopy.Context {
        .init(
            to: check.draft?.to, channel: check.draft?.channel, asker: check.agentName(runtime: runtimeName))
    }
}

/// The card after his tap, every state of it: sending, sent, saved, not sent. Its lines are the action's own steps, so
/// nothing here says a thing happened that Life has not reported.
struct AnswerResultView: View {
    let taken: Taken
    let state: ActionState<ActionProof>
    /// The question of the ask that comes next, when one is waiting.
    let next: String?

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
    }

    private var lines: [CheckLine] { ActionCopy.lines(state, taken.context) }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            // An agent's name is the only thing above the question; Life's own asks have none.
            if let asker = taken.context.asker { chip(asker, "sparkle", tint: Palette.ai) }
        }
    }

    private func chip(_ text: String, _ symbol: String, tint: Color) -> some View {
        Label(text, systemImage: symbol).font(.chip).foregroundStyle(tint)
            .lineLimit(1).padding(.horizontal, 14).frame(minHeight: 40).background(Color.fillTint, in: .capsule)
    }

    // MARK: States

    @ViewBuilder private var working: some View {
        header
        Text(taken.check.question).font(.cardQuestion).foregroundStyle(Palette.fg)
        if let draft = taken.check.draft { DraftBlock(draft: draft) }
        CheckLines(lines: lines.isEmpty ? [CheckLine(id: "asking", text: "Asking Life", mark: .running)] : lines)
            .padding(.top, 8)
    }

    @ViewBuilder private func done(_ proof: ActionProof) -> some View {
        header
        Text(taken.isSend ? "Sent." : doneWord).font(.statusWord).foregroundStyle(Palette.fg).lit().padding(.top, 12)
        Text(summary(proof)).font(.lead).foregroundStyle(Palette.muted)
        CheckLines(lines: lines).padding(.top, 8)
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
        // Life's own reason: on the step it stopped at, else on its own (it stopped before Life's plan).
        CheckLines(
            lines: lines.contains { $0.mark == .failed }
                ? lines : lines + [CheckLine(id: "reason", text: failure.reason, mark: .failed)]
        )
        .padding(.top, 8)
    }

    private var doneWord: String {
        switch taken.check.group {
        case .voice: "Named."
        case .ending: "Noted."
        case .contactsCard: "Saved."
        case .newMatter:
            taken.request.options == ["edit-goal"]
                ? "Goal saved." : taken.request.options == ["dismiss"] ? "Dismissed." : "Started."
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
        if taken.check.group == .newMatter {
            return taken.request.options == ["start"]
                ? "An agent works toward the goal."
                : taken.request.options == ["edit-goal"]
                    ? "The goal is yours now. Start or Dismiss is still waiting." : "Never asked again for this matter."
        }
        if taken.request.options.isEmpty { return "Your words went to \(taken.context.asker ?? "the asker")." }
        let label = taken.check.options.first { taken.request.options.contains($0.id) }?.label
        return label.map { "\($0)." } ?? "Your answer is recorded."
    }

    private func counts(_ proof: ActionProof) -> String? {
        guard case .answered(let result) = proof, let changed = result.changed else { return nil }
        if let name = changed.recordedAs { return "Recorded as \(name)" }
        let parts = [
            changed.voices.map { "\($0) clip\($0 == 1 ? "" : "s")" },
            changed.conversations.map { "\($0) conversation\($0 == 1 ? "" : "s")" },
        ].compactMap(\.self)
        return parts.isEmpty ? nil : parts.joined(separator: " and ") + " now carry the name"
    }

    /// Only what Life said: a call that never gave its answer may have run, so it claims nothing.
    private func failedWord(_ failure: ActionFailure) -> String {
        if failure.mayHaveHappened { return taken.isSend ? "May have gone." : "Check first." }
        if failure.isSameTap { return "No answer from Life." }
        if taken.isStart { return "Not started." }
        return taken.isSend ? "Not sent." : "Not saved."
    }

    private func failedLine(_ failure: ActionFailure) -> String {
        if failure.mayHaveHappened { return "Check before answering again. It stays here." }
        if failure.isSameTap { return "Life may have it: trying again repeats the same tap. It stays here." }
        if taken.isStart, state.steps.contains(where: { $0.id == "goal_saved" && $0.passedAt != nil }) {
            return "Your goal is saved. It stays here."
        }
        return "It stays here."
    }
}

/// What he can do with an ask's result: the way on, or to try again. Apart from the result so a wide screen can put it at the
/// bottom of the screen when the regions are stacked.
struct ResultButtons: View {
    let taken: Taken
    let state: ActionState<ActionProof>
    /// The question of the ask that comes next, when one is waiting.
    let next: String?
    let retry: () -> Void
    let keepForLater: () -> Void
    let nextCard: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            switch state {
            case .succeeded:
                Button(taken.staysOpen ? "Back" : next == nil ? "Done" : "Next", action: nextCard)
                    .buttonStyle(.pill(.filled))
            case .failed(let failure, _):
                if failure.retry == .allowed && !failure.mayHaveHappened {
                    Button("Try again", action: retry).buttonStyle(.pill(.filled))
                    Button("Keep for later", action: keepForLater).buttonStyle(.pill(.quiet))
                    Text(
                        taken.isSend
                            ? "Trying again sends the same text once. It is never sent twice."
                            : "Trying again repeats the same answer once."
                    )
                    .font(.small).foregroundStyle(Palette.faint).multilineTextAlignment(.center)
                } else {
                    Button("Keep for later", action: keepForLater).buttonStyle(.pill(.filled))
                }
            case .idle, .running:
                Button {
                } label: {
                    Text(taken.isSend ? "Sending…" : "Saving…")
                }.buttonStyle(.pill(.quiet, isBusy: true))
                LimitNote(state: state) {
                    taken.isSend
                        ? "Stays here until \(ActionCopy.channel(taken.check.draft?.channel)) answers"
                            + ($0.map { ", \($0)." } ?? ".")
                        : $0.map { "Takes \($0)." } ?? ""
                }
                .font(.small).foregroundStyle(Palette.faint).multilineTextAlignment(.center)
            }
        }
    }
}
