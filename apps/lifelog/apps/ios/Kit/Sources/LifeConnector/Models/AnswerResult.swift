import Foundation
import Library

/// What `answer_check` returns (`host/answer-result.ts`): the proof that his answer was written, what a send did, whether
/// the asker was told and whether the card left. A field Life adds is ignored.
public struct AnswerResult: Decodable, Sendable, Equatable {
    public enum SendState: String, UnknownTolerant, Sendable {
        case sent, pending
        case notSent = "not_sent"
        case mayHaveGone = "may_have_gone"
        case unknown
    }

    public struct Send: Decodable, Sendable, Equatable {
        public let state: SendState
        public let at: Date?
        public let reason: String?
        /// A `not sent` the same tap may be tried again after; `mayHaveGone` never is.
        public let canRetry: Bool?
        public let eventId: String?
        public let channel: String?
        public let to: String?
    }

    public struct Asker: Decodable, Sendable, Equatable {
        public let name: String?
        /// `recorded`, `queued`, `woken`, `on_its_next_poll`, `not_yet`, `not_told`.
        public let told: String?
        public let why: String?
    }

    public struct InboxAfter: Decodable, Sendable, Equatable {
        public let left: Bool
        public let total: Int
        public let deadlinesToday: Int
    }

    /// What changed, for a voice named: the clips and conversations that now carry the name.
    public struct Changed: Decodable, Sendable, Equatable {
        public let voices: Int?
        public let conversations: Int?
    }

    public let ref: String
    public let kind: String
    public let changed: Changed?
    /// Nothing to send: absent.
    public let send: Send?
    public let asker: Asker?
    public let inbox: InboxAfter?
}
