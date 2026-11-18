import LifeConnector

/// What each step of an action says, in the owner's words, and how a state of one becomes the lines under a card. The ids
/// are Life's (`report` in its answer and start); one it adds later reads as its own name, never a blank.
enum ActionCopy {
    struct Context {
        var to: String?
        var channel: String?
        var asker: String?
        var provider: String?
    }

    static func channel(_ source: String?) -> String {
        switch source {
        case "whatsapp": "WhatsApp"
        case "imessage": "iMessage"
        case "messenger": "Messenger"
        case "instagram": "Instagram"
        case "linkedin": "LinkedIn"
        case "telegram": "Telegram"
        case "line": "LINE"
        case "gmail", "mail": "Mail"
        case let other?: other.capitalized
        case nil: "The chat"
        }
    }

    static func text(of step: String, _ context: Context, passed: Bool = true) -> String {
        switch step {
        case "recorded": "Your answer is recorded"
        case "chat_checked":
            context.to.map { "The chat is \($0)’s, and nobody wrote since the draft" } ?? "The chat is the right one"
        case "handed": "Sending exactly this text"
        case "confirmed": "\(channel(context.channel)) confirms it"
        case "asker_told": "\(context.asker ?? "The asker") knows, and goes on"
        case "left_inbox": "The card left your inbox"
        case "goal_saved": "Your goal is saved on the matter"
        case "runtime_answers": "\(context.provider ?? "The runtime") answers"
        case "session_open": passed ? "Its session is open" : "Opening its session"
        case "turn_begun": "Its first turn has begun"
        default: step.replacing("_", with: " ").capitalized
        }
    }

    /// One line per step of the plan: passed, the one under way, the ones waiting; on a failure the step it stopped at
    /// says why in Life's words.
    static func lines(_ state: ActionState<ActionProof>, _ context: Context) -> [CheckLine] {
        var failure: ActionFailure?
        if case .failed(let why, _) = state { failure = why }
        var running = state.isRunning
        return state.steps.map { step in
            let text = text(of: step.id, context, passed: step.passedAt != nil)
            if step.passedAt != nil { return CheckLine(id: step.id, text: text, mark: .passed) }
            if let failure {
                return step.id == failure.step
                    ? CheckLine(id: step.id, text: failure.reason, mark: .failed)
                    : CheckLine(id: step.id, text: text, mark: .waiting)
            }
            defer { running = false }
            return CheckLine(id: step.id, text: text, mark: running ? .running : .waiting)
        }
    }
}
