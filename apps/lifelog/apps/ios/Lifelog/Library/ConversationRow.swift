import Foundation
import Library
import ServerAPI
import Timeline
import Upload

/// One conversation as the library shows it: the feed's row, what the cache says of it, where it stands
/// (`ConversationState`) and whether an edit of it waits for the server.
struct ConversationRow: Identifiable, Equatable {
    let id: UUID
    var title: String?
    /// The generated one-line summary, once there is one.
    var summary: String?
    /// The first words said, shown until there is a summary.
    var opening: String?
    var start: Date
    var end: Date
    var people: [String] = []
    var place: String?
    var state = ConversationState.summarized
    /// Why its words or summary wait, in the feed's words (`WaitingReason`).
    var waiting: WaitingReason?
    /// A title or a split or merge of it waits for the server.
    var editWaiting = false
    /// Audio on this phone the server has no conversation for yet: it plays from here, and opens no page.
    var isLocal = false
    /// A recording from the old app: it is never split or merged.
    var isImported = false
    /// The text around a search match.
    var snippet: String?
    /// Start of the passage holding the search match; `nil` when it matched elsewhere (a title).
    var match: CaptureInstant?
    /// Only the server's search by meaning found it, not the words typed.
    var byMeaning = false

    var range: Range<CaptureInstant> { CaptureInstant(start)..<CaptureInstant(end) }

    /// The one name for a conversation without a title, in the library, the reader and the player: "Conversation at
    /// 13:52". The place shows beside it, never in it.
    static func untitledName(start: Date) -> String {
        "Conversation at \(start.formatted(.dateTime.hour().minute()))"
    }
}

extension ConversationRow {
    /// A row from the cache: `unsent` (the audio the server doesn't have yet, around it) and the feed's state say where
    /// it stands, `pending` what waits of the owner's.
    init(
        _ conversation: CachedConversation, facts: ConversationFacts?, unsent: [Range<CaptureInstant>],
        pending: PendingEdits
    ) {
        let title = pending.titles[conversation.id]
        self.init(
            id: conversation.id, title: title.map { $0 ?? conversation.title } ?? conversation.shownTitle,
            summary: conversation.tldr, opening: conversation.tldr == nil ? facts?.opening : nil,
            start: conversation.startAt, end: conversation.endAt, people: facts?.people ?? [],
            place: conversation.place,
            state: ConversationState(conversation, unsent: unsent.contains { $0.overlaps(conversation.range) }),
            waiting: conversation.waiting?.reason,
            editWaiting: title != nil || pending.regrouping(conversation.range),
            isImported: conversation.isImported)
    }

    /// A wordless recording or dictation to the Mac, as the day's quiet line opens it.
    init(quiet conversation: CachedConversation) {
        let dictation = conversation.kind == .dictation
        self.init(
            id: conversation.id, title: conversation.shownTitle ?? (dictation ? "Dictation to your Mac" : "No words"),
            summary: dictation ? "Left out of transcription." : "Recorded, with nothing to transcribe.",
            start: conversation.startAt, end: conversation.endAt, place: conversation.place, state: .transcribed)
    }

    /// Audio not uploaded yet, as one row.
    init(local range: Range<CaptureInstant>) {
        self.init(
            id: ConversationID(anchor: range.lowerBound).serverID, title: "Not uploaded yet",
            start: range.lowerBound.date, end: range.upperBound.date, state: .notUploaded, isLocal: true)
    }

    /// Where it stands while it isn't done, said once, in words and a glyph; `nil` once it is.
    var badge: (title: String, glyph: ProcessingBadge.Glyph)? {
        switch state {
        case .notUploaded: isLocal ? nil : ("Not uploaded yet", .waiting)
        case .uploaded: ("Uploaded", .waiting)
        case .transcribing: ("Transcribing…", .working)
        case .failed: ("Couldn’t transcribe", .waiting)
        case .summarized: nil
        case .transcribed: waiting.map { ($0.sentence, .waiting) }
        }
    }
}
