/// The accessibility identifiers the end-to-end tests find elements by (`LifelogE2E`, which compiles this file too).
/// Screens use these constants and never write an identifier of their own; a screen that is redrawn keeps them.
/// Elements with a fixed label and no id of their own (the thread's round "What's waiting on me" and "Pendant"
/// buttons, "Pair Life") are found by that label.
enum AID {
    // Pairing sheet (`PairSheet`)
    static let pairConfirm = "pair.confirm"
    static let pairDone = "pair.done"
    static let pairRetry = "pair.retry"
    static let pairCancel = "pair.cancel"

    // The notices at the top of the thread (`Notices`)
    static let noticeOutOfReach = "notice.outOfReach"
    static let noticeBack = "notice.back"

    // One ask of the thread (`ItemRow`), by its ref
    static func askRow(_ ref: String) -> String { "ask.row.\(ref)" }
    static func askAnswer(_ ref: String, _ option: String) -> String { "ask.answer.\(ref).\(option)" }
    static func askQueued(_ ref: String) -> String { "ask.queued.\(ref)" }
    static func askSettled(_ ref: String) -> String { "ask.settled.\(ref)" }
    static func askFailure(_ ref: String) -> String { "ask.failure.\(ref)" }
    static func askUndo(_ ref: String) -> String { "ask.undo.\(ref)" }
    // The folded voices row and its card (`VoicesRow`)
    static let voicesRow = "voices.row"
    static func voicesAnswer(_ id: String) -> String { "voices.answer.\(id)" }
    static let voicesAnother = "voices.another"
    static let voicesUndo = "voices.undo"
    static func voicesPerson(_ ref: String) -> String { "voices.person.\(ref)" }
    static func askRate(_ ref: String, _ mark: String) -> String { "ask.rate.\(ref).\(mark)" }
}
