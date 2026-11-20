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
    /// He picked the option that sends the draft; another answer on a draft's card sends nothing.
    var isSend: Bool { check.options.contains { $0.outgoing == true && request.options.contains($0.id) } }
    var isStart: Bool { check.group == .newMatter && request.options == ["start"] }
    /// His word that the step or matter is done: held for Undo wherever the card is shown.
    var isEnding: Bool { check.isEnding(request) }
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

    private var lines: [CheckLine] {
        // A send shows only the steps of its send (`sendStepsOf` on Life's side): its answer line is not one.
        ActionCopy.lines(state, taken.context).filter { !taken.isSend || $0.id != "recorded" || $0.mark == .failed }
    }

    // MARK: States

    @ViewBuilder private var working: some View {
        Text(taken.check.question).font(.cardQuestion).foregroundStyle(Palette.fg)
        if let draft = taken.check.draft {
            DraftBlock(draft: draft, identity: taken.check.networkIdentity, isGuess: taken.isGuess, isBoxed: false)
        }
        CheckLines(lines: lines.isEmpty ? [CheckLine(id: "asking", text: "Asking Life", mark: .running)] : lines)
            .padding(.top, 8)
    }

    @ViewBuilder private func done(_ proof: ActionProof) -> some View {
        Text(taken.doneWord).font(.statusWord).foregroundStyle(Palette.ok).lit().padding(.top, 12)
        Text(taken.summary(proof)).font(.lead).foregroundStyle(Palette.muted)
        CheckLines(lines: lines).padding(.top, 8)
        if let changed = taken.counts(proof) {
            Text(changed).font(.body15).foregroundStyle(Palette.muted)
        }
    }

    @ViewBuilder private func failed(_ failure: ActionFailure) -> some View {
        Text(taken.failedWord(failure)).font(.statusWord).foregroundStyle(Palette.flag).padding(.top, 12)
        if taken.isSend {
            // A send says only Life's reason, then the words that did not go.
            Text(failure.reason).font(.lead).foregroundStyle(Palette.muted)
            if !failure.mayHaveHappened, let draft = taken.check.draft {
                DraftBlock(draft: draft, identity: taken.check.networkIdentity, isGuess: taken.isGuess, isBoxed: false)
                    .padding(.top, 8)
            }
        } else {
            Text(taken.failedLine(failure, state)).font(.lead).foregroundStyle(Palette.muted)
            CheckLines(lines: lines).padding(.top, 8)
        }
    }
}

/// What he can do with an ask's result when it did not end well: try again, open the chat, or keep it for later. A result
/// that worked has none: the next ask comes by itself. Apart from the result so a wide screen can put it at the bottom of
/// the screen when the regions are stacked.
struct ResultButtons: View {
    let taken: Taken
    let state: ActionState<ActionProof>
    let retry: () -> Void
    let keepForLater: () -> Void

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(spacing: 8) {
            switch state {
            case .succeeded:
                EmptyView()
            case .failed(let failure, _):
                if failure.retry == .allowed && !failure.mayHaveHappened {
                    Button("Try again", action: retry).buttonStyle(.pill(.filled))
                    Button("Keep for later", action: keepForLater).buttonStyle(.pill(.quiet))
                } else if failure.mayHaveHappened, let url = taken.check.networkIdentity?.openUrl {
                    Button("Open the chat") { openURL(url) }.buttonStyle(.pill(.filled))
                } else {
                    Button("Keep for later", action: keepForLater).buttonStyle(.pill(.filled))
                }
            case .idle, .running:
                Button {
                } label: {
                    Text(taken.isSend ? "Sending…" : "Saving…")
                }.buttonStyle(.pill(.quiet, isBusy: true))
            }
        }
    }
}

/// What a card's answer came to, in words: the result screen and the notification it was answered from say the same.
extension Taken {
    /// Its word and line once `state` ended (for a notification, which shows one of each).
    func result(_ state: ActionState<ActionProof>) -> (word: String, line: String) {
        switch state {
        case .succeeded(let proof, _): (doneWord, summary(proof))
        case .failed(let failure, _): (failedWord(failure), failedLine(failure, state))
        case .running: ("Check first.", "It stays here.")
        case .idle: ("Not saved.", "It stays here.")
        }
    }

    /// His answer in its own words, for the toast that holds it: the option's, or who he named, or what he wrote.
    var heldWords: String {
        if let option = check.options.first(where: { request.options.contains($0.id) }), option.takes == nil {
            return option.label
        }
        if let person = check.likelyPeople.first(where: { $0.person == request.person }) { return person.name }
        return request.name ?? (request.note == nil ? "Your answer" : "Your words")
    }

    /// Held for Undo: any answer that is not a send, a start or a goal edit (Life has no undo for those).
    var isHeld: Bool { !isSend && !isStart && !staysOpen }
    var isGuess: Bool { check.isRecipientGuessed }

    var doneWord: String {
        if isSend { return "Sent." }
        return switch check.group {
        case .voice: "Named."
        case .ending: "Noted."
        case .contactsCard: "Saved."
        case .newMatter:
            request.options == ["edit-goal"]
                ? "Goal saved." : request.options == ["dismiss"] ? "Dismissed." : "Started."
        case .name, .guessedPerson: "Saved."
        case .decision, .unknown: "Answered."
        }
    }

    func summary(_ proof: ActionProof) -> String {
        guard case .answered(let result) = proof else { return "" }
        if let send = result.send {
            let to = [check.draft?.to, send.channel.map(Channel.name)].compactMap(\.self)
            let when = send.at.map { ", at \($0.formatted(.dateTime.hour().minute()))" } ?? ""
            return "To \(to.joined(separator: " on "))\(when)."
        }
        if check.group == .newMatter {
            return request.options == ["start"]
                ? "An agent works toward the goal."
                : request.options == ["edit-goal"]
                    ? "The goal is yours now. Start or Dismiss is still waiting." : "Never asked again for this matter."
        }
        if request.options.isEmpty { return "Your words went to \(context.asker ?? "the asker")." }
        let label = check.options.first { request.options.contains($0.id) }?.label
        return label.map { "\($0)." } ?? "Your answer is recorded."
    }

    func counts(_ proof: ActionProof) -> String? {
        guard case .answered(let result) = proof, let changed = result.changed else { return nil }
        if let name = changed.recordedAs { return "Recorded as \(name)" }
        let parts = [
            changed.voices.map { "\($0) clip\($0 == 1 ? "" : "s")" },
            changed.conversations.map { "\($0) conversation\($0 == 1 ? "" : "s")" },
        ].compactMap(\.self)
        return parts.isEmpty ? nil : parts.joined(separator: " and ") + " now carry the name"
    }

    /// Only what Life said: a call that never gave its answer may have run, so it claims nothing.
    func failedWord(_ failure: ActionFailure) -> String {
        if failure.mayHaveHappened { return isSend ? "May have gone." : "Check first." }
        if failure.isSameTap { return "No answer from Life." }
        if isStart { return AgentWords.notStarted + "." }
        return isSend ? "Not sent." : "Not saved."
    }

    func failedLine(_ failure: ActionFailure, _ state: ActionState<ActionProof>) -> String {
        if failure.mayHaveHappened { return "Check before answering again. It stays here." }
        if failure.isSameTap { return "Life may have it: trying again repeats the same tap. It stays here." }
        if isStart, state.steps.contains(where: { $0.id == "goal_saved" && $0.passedAt != nil }) {
            return "Your goal is saved. It stays here."
        }
        return "It stays here."
    }
}
