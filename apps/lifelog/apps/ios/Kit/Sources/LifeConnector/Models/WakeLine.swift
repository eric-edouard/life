import Foundation
import Library

/// One line of what will wake a waiting agent (`wakesOn` of `RegisteredAgent`), in the agent's own order. A kind the app
/// does not know yet (`places`, `calendar`...) decodes as `unknown` and reads "Something new in <its name>".
public enum WakeLine: Decodable, Sendable, Equatable {
    case message(Message)
    case payments(Payments)
    case answer(Answer)
    /// Anything new close to the agent's matter.
    case wideNet
    case unknown(kind: String)

    /// Why a line can never fire, as a code the app words.
    public enum Broken: String, UnknownTolerant, Sendable {
        case unknownPerson = "unknown_person"
        case unknown
    }

    public struct Message: Decodable, Sendable, Equatable {
        public struct Chat: Decodable, Sendable, Equatable {
            /// Nil: no message was seen in this chat yet.
            public let name: String?
            public let app: String?
            public let group: Bool?
        }

        /// Who the filter's person is now, when they resolve.
        public let party: Party?
        /// The filter's person as the agent wrote it: the words shown when they no longer resolve.
        public let personAsWritten: String?
        public let chat: Chat?
        /// Absent: any app.
        public let apps: [String]?
        public let words: String?
        public let fromHim: Bool?
        /// The line also covers a call (a call has no words and is never his own).
        public let calls: Bool
        public let broken: Broken?

        /// The person it listens for, by name: who they are now, else the words as written.
        public var person: String? { party?.name ?? personAsWritten }
    }

    public struct Payments: Decodable, Sendable, Equatable {
        public let quantity: String?
        public let above: Double?
        public let below: Double?
        public let words: String?
    }

    public struct Answer: Decodable, Sendable, Equatable {
        /// The open ask's question.
        public let card: String
        /// The ask's check ref.
        public let check: String
        public let deadline: Date
    }

    private enum Key: String, CodingKey { case kind }

    public init(from decoder: any Decoder) throws {
        let kind = try decoder.container(keyedBy: Key.self).decode(String.self, forKey: .kind)
        switch kind {
        case "message": self = .message(try Message(from: decoder))
        case "payments": self = .payments(try Payments(from: decoder))
        case "answer": self = .answer(try Answer(from: decoder))
        case "wide_net": self = .wideNet
        default: self = .unknown(kind: kind)
        }
    }
}
