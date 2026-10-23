import Foundation
import Library
import Timeline

/// `conversation.json`, version 3 (docs/formats.md). Every moment carries capture time (Unix ms) and audio time (ms
/// into the exported audio).
public struct ConversationDocument: Codable, Sendable, Equatable {
    public static let version = 3

    public struct Moment: Codable, Sendable, Equatable {
        public var captureMs: Int64
        public var audioMs: Int64
    }

    public struct Title: Codable, Sendable, Equatable {
        public var text: String
        /// "owner" or "generated".
        public var source: String
    }

    public struct Chapter: Codable, Sendable, Equatable {
        public var at: Moment
        public var title: String?
        public var summary: String?
    }

    public struct Turn: Codable, Sendable, Equatable {
        /// The provider's label within its job, e.g. "speaker_0".
        public var speaker: String?
        public var name: String
        public var personId: UUID?
        public var start: Moment
        public var end: Moment
        public var text: String
        public var language: String?
    }

    public struct Location: Codable, Sendable, Equatable {
        public var at: Moment
        public var latitude: Double
        public var longitude: Double
        public var accuracyMeters: Double
    }

    public struct Span: Codable, Sendable, Equatable {
        public var start: Moment
        public var end: Moment
    }

    public var version: Int
    /// The server's conversation id.
    public var id: String
    public var start: Moment
    public var end: Moment
    public var startUTC: String
    public var timeZone: String
    /// `conversation`, `dictation`, `silent` or `imported`.
    public var kind: String
    public var title: Title?
    public var tldr: String?
    public var place: String?
    public var chapters: [Chapter]
    public var transcript: [Turn]
    /// Present exactly when there is no transcript text; says why.
    public var transcriptAbsent: String?
    public var locations: [Location]
    /// Stretches the Pendant did not record; the audio holds silence there.
    public var unrecorded: [Span]
}

extension ConversationExport {
    public func document() -> ConversationDocument {
        // Clamped, so a turn straddling an edge of a partial export stays inside it.
        let moment = { (instant: CaptureInstant) in
            let instant = min(max(instant, range.lowerBound), range.upperBound)
            return ConversationDocument.Moment(captureMs: instant.millis, audioMs: audioMillis(instant))
        }
        return ConversationDocument(
            version: ConversationDocument.version, id: conversation.id.uuidString.lowercased(),
            start: moment(range.lowerBound), end: moment(range.upperBound), startUTC: utc(range.lowerBound),
            timeZone: timeZone.identifier, kind: conversation.kind.rawValue,
            title: conversation.shownTitle.map {
                .init(text: $0, source: conversation.ownerTitle == nil ? "generated" : "owner")
            },
            tldr: conversation.tldr, place: conversation.place,
            chapters: chapters.map { .init(at: moment($0.start), title: $0.title, summary: $0.summary) },
            transcript: turns.map {
                .init(
                    speaker: $0.speaker.label, name: $0.speaker.displayName, personId: $0.speaker.personId,
                    start: moment($0.range.lowerBound), end: moment($0.range.upperBound), text: $0.text,
                    language: $0.language)
            },
            transcriptAbsent: absentTranscript,
            locations: observations.map {
                .init(
                    at: moment($0.at), latitude: $0.latitude, longitude: $0.longitude, accuracyMeters: $0.accuracyMeters
                )
            },
            unrecorded: unrecorded.map { .init(start: moment($0.lowerBound), end: moment($0.upperBound)) })
    }

    public func json() throws -> String {
        String(decoding: try ConversationDocument.encoder.encode(document()), as: UTF8.self) + "\n"
    }
}

extension ConversationDocument {
    /// Sorted keys and ISO 8601 dates, so the same input always gives the same bytes.
    static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
