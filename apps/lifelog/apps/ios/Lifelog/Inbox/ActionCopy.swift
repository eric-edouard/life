import LifeConnector

/// What each step of an action says, in the owner's words, and how a state of one becomes the lines under a card. The ids
/// are Life's (`report` in its answer and start); one it adds later reads as its own name, never a blank.
enum ActionCopy {
    struct Context {
        var to: String?
        var channel: String?
        var asker: String?
    }

    static func text(of step: String, _ context: Context, passed: Bool = true, detail: [String: String] = [:]) -> String
    {
        switch step {
        case "recorded": "Your answer is recorded"
        case "chat_checked":
            context.to.map { "The chat is \($0)’s, and nobody wrote since the draft" } ?? "The chat is the right one"
        case "handed": "Sending exactly this text"
        case "confirmed": "\(Channel.name(context.channel)) confirms it"
        case "connection_retry":
            "The connection dropped; trying again (\(detail["try"] ?? "2") of \(detail["of"] ?? "3"))"
        case "todo_items_ticked":
            detail["of"].map { "\(detail["done"] ?? "0") of \($0) to-do items ticked" } ?? "Its to-do items are ticked"
        case "goal_saved": "Your goal is saved on the matter"
        case "desk_accepted": "The desk took the start"
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
            let text = text(of: step.id, context, passed: step.passedAt != nil, detail: step.detail)
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
