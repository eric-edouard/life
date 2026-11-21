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
    var staysOpen: Bool { check.keepsOpen(after: request) }
    /// He picked the option that sends the draft; another answer on a draft's card sends nothing.
    var isSend: Bool { check.options.contains { $0.outgoing == true && request.options.contains($0.id) } }
    var isStart: Bool { check.options.contains { request.options == [$0.id] && check.isHandOver($0) } }
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
    /// Each new state shows from its top (a long draft scrolled while sending would hide "Not sent"); a step ticking
    /// within one state keeps where he scrolled.
    @State private var position = ScrollPosition(edge: .top)

    var body: some View {
        ScrollView {
            // A new state fades the last one out and rises in its place (`Motion.resultFace`).
            ZStack(alignment: .topLeading) {
                switch state {
                // A send stays one face from the tap to its proof, the ticks landing in the bubble itself; one Life saw
                // in its chat is sent, even when its answer was lost on the way.
                case _ where taken.isSend && (state.isRunning || state.isDone(isSend: true)): face { sending }
                case .failed(let failure, _): face { failed(failure) }
                case _ where taken.isSend: face { sending }
                case .succeeded(let proof, _): face { done(proof) }
                case .idle, .running: face { working }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 16)
            .readingWidth()
        }
        .scrollPosition($position)
        .scrollBounceBehavior(.basedOnSize)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
    }

    private var lines: [CheckLine] {
        // A send shows only the steps of its send (`sendStepsOf` on Life's side): its answer line is not one.
        ActionCopy.lines(state, taken.context).filter { !taken.isSend || $0.id != "recorded" || $0.mark == .failed }
    }

    // MARK: States

    private func face(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 14) { content() }
            .appears(Motion.resultFace)
            .onAppear { position.scrollTo(edge: .top) }
    }

    @ViewBuilder private var working: some View {
        Text(taken.check.question).font(.cardQuestion).foregroundStyle(Palette.fg)
        DraftBlock(check: taken.check, isBoxed: false)
        stepLines
    }

    /// The action's steps as they pass; "Asking Life" only while the request runs.
    private var stepLines: some View {
        let asking = [CheckLine(id: "asking", text: "Asking Life", mark: .running)]
        return CheckLines(lines: lines.isEmpty && state.isRunning ? asking : lines).padding(.top, 8)
    }

    /// A send, from his tap to its proof: the draft in its chat, its ticks as the send's steps pass, then Life's word.
    @ViewBuilder private var sending: some View {
        if !state.isRunning, state != .idle {
            let result = taken.result(state)
            Text(result.word).font(.statusWord).foregroundStyle(Palette.ok).lit().appears()
            Text(result.line).font(.lead).foregroundStyle(Palette.muted).appears()
        } else {
            Text(taken.check.question).font(.cardQuestion).foregroundStyle(Palette.fg)
        }
        DraftBlock(check: taken.check, delivery: DraftDelivery(state), isBoxed: false)
        stepLines
    }

    @ViewBuilder private func done(_ proof: ActionProof) -> some View {
        Text(taken.doneWord(proof)).font(.statusWord).foregroundStyle(Palette.ok).lit().padding(.top, 12)
        Text(taken.summary(proof)).font(.lead).foregroundStyle(Palette.muted)
        CheckLines(lines: lines).padding(.top, 8)
        if let changed = taken.counts(proof) {
            Text(changed).font(.body15).foregroundStyle(Palette.muted)
        }
    }

    @ViewBuilder private func failed(_ failure: ActionFailure) -> some View {
        Text(taken.failedWord(failure, state)).font(.statusWord).foregroundStyle(Palette.flag).padding(.top, 12)
        if taken.isSend {
            // A send says only Life's reason, then the words, "Not sent" or "May have gone" where the ticks would be.
            Text(failure.reason).font(.lead).foregroundStyle(Palette.muted)
            DraftBlock(check: taken.check, delivery: DraftDelivery(state), isBoxed: false).padding(.top, 8)
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
            // Seen in its chat: done, nothing to try again.
            case .failed where state.isDone(isSend: taken.isSend):
                EmptyView()
            case .failed(let failure, _):
                if state.offersRetry(isSend: taken.isSend) {
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
        case .succeeded(let proof, _): (doneWord(proof), summary(proof))
        case .failed(let failure, _): (failedWord(failure, state), failedLine(failure, state))
        case .running: ("Check first.", "It stays here.")
        case .idle: ("Not saved.", "It stays here.")
        }
    }

    /// His answer in its own words, for the toast that holds it: the option's, or who he named, or what he wrote.
    var heldWords: String {
        if let option = check.options.first(where: { request.options.contains($0.id) }), option.takes == nil {
            return option.label
        }
        if let person = check.likelyPeople.first(where: { $0.ref == request.person }) { return person.name }
        return request.name ?? (request.note == nil ? "Your answer" : "Your words")
    }

    /// Held for Undo: any answer that is not a send, a start, a goal edit (Life has no undo for those) or a new person's
    /// name (Life reads who that is, or adds them to his directory: its result, or why not, shows on its card first).
    var isHeld: Bool { !isSend && !isStart && !staysOpen && request.name == nil }

    /// "Sent." only on Life's proof that it went; an answer that sent nothing takes its card's word.
    func doneWord(_ proof: ActionProof) -> String {
        if isSend && proof.isSent { return "Sent." }
        return switch check.group {
        case .voice: "Named."
        case .ending: "Noted."
        case .contactsCard: "Saved."
        case .newMatter:
            staysOpen
                ? "Goal saved." : request.options == ["dismiss"] ? "Dismissed." : "Started."
        case .yourMove: isStart ? "Started." : request.options == ["not-now"] ? "Not now." : "Done."
        case .name, .guessedPerson, .samePerson: "Saved."
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
        if isStart { return "An agent works toward the goal." }
        if let back = result.changed?.backOn { return "Back in your inbox on \(back)." }
        if check.group == .newMatter {
            return staysOpen
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
    /// A send's word is its bubble's (`DraftDelivery`): a draft Life saw in its chat is "Sent." whatever came after.
    func failedWord(_ failure: ActionFailure, _ state: ActionState<ActionProof>) -> String {
        if isSend { return DraftDelivery(state).word }
        if failure.mayHaveHappened { return "Check first." }
        if failure.isSameTap { return "No answer from Life." }
        if isStart { return AgentWords.notStarted + "." }
        return "Not saved."
    }

    func failedLine(_ failure: ActionFailure, _ state: ActionState<ActionProof>) -> String {
        if isSend, DraftDelivery(state) == .sent { return "Life saw it in the chat. Its answer was lost on the way." }
        if failure.mayHaveHappened { return "Check before answering again. It stays here." }
        if failure.isSameTap { return "Life may have it: trying again repeats the same tap. It stays here." }
        if isStart, state.steps.contains(where: { $0.id == "goal_saved" && $0.passedAt != nil }) {
            return "Your goal is saved. It stays here."
        }
        return "It stays here."
    }
}
