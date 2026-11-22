import Foundation
import Library

/// A page of a matter's thread (`fetch <matter id>/thread`, `readMatterThread`): the lines its facts cite, its moments
/// with their payments, its events, to-do items and Life's steps, in time order, the newest 30 by whole days. Older
/// ones are the page `nextBefore` names. Its open asks are the matter read's `checks`, not part of it.
public struct MatterThread: Decodable, Sendable, Equatable, ParsedRead, NamesParties {
    public let matter: String
    /// The day to page back from (`<id>/thread/before/<day>`); nil on the oldest page.
    public let nextBefore: String?
    public let lines: [Line]

    private enum CodingKeys: String, CodingKey {
        case matter, nextBefore
        case lines = "thread"
    }

    public var parties: [Party] { lines.compactMap(\.speaker) }

    /// The ref of the page before this one, as `fetch` opens it.
    public var earlier: String? { nextBefore.map { "\(matter)/thread/before/\($0)" } }

    /// What a line is; Life adds kinds, so an unknown one is drawn as its words.
    public enum Kind: String, UnknownTolerant, Sendable {
        case message, call, voice, quote, moment, payment, event, life
        case todoItem = "todo_item"
        case unknown
    }

    public struct Line: Decodable, Sendable, Equatable, Identifiable {
        public let at: Date
        public let day: String
        public let kind: Kind
        public let text: String
        /// Who wrote or said it, on a message, call, voice line or quote.
        public let speaker: Party?
        /// The network it came from ("whatsapp"), on those lines.
        public let channel: String?
        /// The link into its app, when Life has one.
        public let open: URL?
        /// What `fetch` opens (a message's `msg:` ref, an event's id).
        public let ref: String?
        /// The matter step a moment, a to-do item or Life's step stands for.
        public let step: String?
        /// A payment's amount (negative: money out), its currency and its category.
        public let amount: Double?
        public let currency: String?
        public let category: String?
        /// An event's start, as Life writes it (a local time or an instant).
        public let start: String?
        /// A call's cut of its recording.
        public let span: Span?

        public struct Span: Decodable, Sendable, Equatable {
            public let at: Date
            public let until: Date
        }

        public var id: String { "\(kind.rawValue)|\(ref ?? step ?? "")|\(at.timeIntervalSince1970)|\(text.prefix(24))" }

        /// Whether he wrote or said it.
        public var isHis: Bool { speaker?.isOwner == true }

        /// A payment as a line says it: "Watch Shop, 45 EUR".
        public var paymentWords: String? {
            guard kind == .payment, let amount else { return nil }
            let figure = abs(amount).formatted(.number.precision(.fractionLength(0...2)))
            return [text, [figure, currency].compactMap(\.self).joined(separator: " ")].joined(separator: ", ")
        }
    }
}
