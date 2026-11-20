import Foundation
import Library

/// What `answer_check` returns (`host/answer-result.ts`): the proof that his answer was written, what a send did and
/// whether the asker was told. A field Life adds is ignored; the inbox is read again after every answer.
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
        /// A `not sent` because someone wrote in the chat since the card was asked: the message that refused it (`decisions.ts`'s `notSentOf`).
        public let wrote: ActionFailure.Wrote?
        public let channel: String?
        public let to: String?
    }

    public struct Asker: Decodable, Sendable, Equatable {
        public let name: String?
        /// `recorded`, `queued`, `woken`, `on_its_next_poll`, `not_yet`, `not_told`.
        public let told: String?
        public let why: String?
    }

    /// What changed, for a voice named: the clips and conversations that now carry the name.
    public struct Changed: Decodable, Sendable, Equatable {
        public let voices: Int?
        public let conversations: Int?
        /// The person a typed name was read as. Picked from the card, or no person: absent.
        public let recordedAs: String?
    }

    public let ref: String
    public let kind: String
    public let changed: Changed?
    /// Nothing to send: absent.
    public let send: Send?
    public let asker: Asker?
    /// A new matter's Start: the desk's start, as `change_registered_agent` gives it. Nothing started: absent.
    public let start: AgentChangeResult?
    /// "I've paid": Life's look for the step done, `seen` or `not_found`, beside the answer. No look: absent.
    public let doneSeen: Check.DoneSeen?
}
