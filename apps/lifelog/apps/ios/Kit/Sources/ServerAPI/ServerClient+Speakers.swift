import Foundation
import Library
import Timeline

extension ServerClient {
    // MARK: Voices to name

    /// A voice to name (openapi `QueueItem`): an unnamed voice of the last 30 days that talked with the owner, across
    /// its conversations and days, with clean clips of it and who it may be.
    public struct NamingItem: Sendable, Codable, Equatable, Identifiable {
        public enum Kind: String, Sendable, UnknownTolerant, Encodable {
            case newPerson = "new_person", knownPerson = "known_person", several, unknown
        }
        /// A turn where its name was said.
        public struct Quote: Sendable, Codable, Equatable {
            public var at: Date?
            public var conversationId: UUID
            public var text: String
        }
        /// A clean turn of its voice to hear, in capture time, with the words said before it is cut; no times when the
        /// server can't place it, so the words alone. Its turn is what "several people" names in place.
        public struct Clip: Sendable, Codable, Equatable {
            /// Seconds of a job's audio as the server keeps it (`jobAudio`); `nil` for a job from before the bucket.
            public struct Audio: Sendable, Codable, Equatable {
                public var jobId: UUID
                public var start: Double
                public var end: Double
            }

            public var at: Date?
            public var audio: Audio?
            public var conversationId: UUID
            public var text: String
            public var until: Date?
            public var jobId: UUID?
            public var speakerLabel: String?
            public var turnIndex: Int?
            /// Who the turn reads as now.
            public var personId: UUID?
            /// From `at`.
            public var words: [[Int64]]?
        }
        public struct Voice: Sendable, Codable, Equatable {
            public var conversationId: UUID
            public var jobId: UUID
            public var speakerLabel: String
        }

        /// Its voice group, stable until the server's nightly regroup.
        public var id: String
        public var kind: Kind
        /// The name the summaries heard for it.
        public var name: String?
        /// For `knownPerson`: who it sounds like.
        public var personId: UUID?
        public var conversations: Int
        public var seconds: Double
        /// Turns it traded with the owner.
        public var exchanges: Int
        public var evidence: [Quote]
        public var voices: [Voice]
        /// Best first.
        public var clips: [Clip]
    }

    /// A job's audio as the server keeps it (Ogg Opus), for a clip to play.
    public func jobAudio(_ job: UUID) async throws -> Data {
        try await send(try request("transcripts/\(lower(job))/audio"))
    }

    /// The voices to name, the most back-and-forth with the owner first.
    public func namingQueue() async throws -> [NamingItem] {
        try decode([NamingItem].self, try await send(try request("naming-queue")))
    }

    /// The owner's answer for a voice to name (openapi `/naming-queue/answer`).
    public enum NamingAnswer: Sendable, Equatable, Codable {
        /// Someone new, named so.
        case confirm(name: String)
        /// One of the owner's people.
        case assign(UUID)
        /// Not anyone to name: never asked about again.
        case ignore
        /// A video, TV or radio playing: left out of summaries and search, never a voice profile.
        case media
        /// Several people under one voice: who among the owner's people, someone unknown too. Its passages are named
        /// in place first, one turn at a time.
        case several(people: [UUID], unknown: Bool)
        /// Only an answer kept from before Oct 15, sent as it was.
        case rest

        private enum Keys: String, CodingKey { case kind, name, personId, people, unknown }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: Keys.self)
            switch self {
            case .confirm(let name):
                try container.encode("confirm", forKey: .kind)
                try container.encode(name, forKey: .name)
            case .assign(let id):
                try container.encode("assign", forKey: .kind)
                try container.encode(id.uuidString.lowercased(), forKey: .personId)
            case .ignore: try container.encode("ignore", forKey: .kind)
            case .media: try container.encode("media", forKey: .kind)
            case .rest: try container.encode("rest", forKey: .kind)
            case .several(let people, let unknown):
                try container.encode("several", forKey: .kind)
                try container.encode(people.map { $0.uuidString.lowercased() }, forKey: .people)
                try container.encode(unknown, forKey: .unknown)
            }
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: Keys.self)
            switch try container.decode(String.self, forKey: .kind) {
            case "confirm": self = .confirm(name: try container.decode(String.self, forKey: .name))
            case "assign": self = .assign(try container.decode(UUID.self, forKey: .personId))
            case "media": self = .media
            // "Assign the rest", gone Oct 15: a waiting one goes as it was, for the server to refuse, never as `ignore`.
            case "rest": self = .rest
            case "several":
                self = .several(
                    people: try container.decodeIfPresent([UUID].self, forKey: .people) ?? [],
                    unknown: try container.decodeIfPresent(Bool.self, forKey: .unknown) ?? false)
            default: self = .ignore
            }
        }
    }

    /// Who the owner says a speaker is (openapi `SpeakerTarget`).
    public enum SpeakerTarget: Sendable, Equatable, Codable {
        case person(UUID)
        /// A new person with this name, under the id the phone chose, so a replay names the same person.
        case new(name: String, personId: UUID = UUID())
        case unknown
        /// A video, TV or radio playing: hidden from summaries and search, never a voice profile.
        case media

        private enum Keys: String, CodingKey { case kind, personId, name, id }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: Keys.self)
            switch self {
            case .person(let id):
                try container.encode("person", forKey: .kind)
                try container.encode(id.uuidString.lowercased(), forKey: .personId)
            case .new(let name, let id):
                try container.encode("new", forKey: .kind)
                try container.encode(name, forKey: .name)
                try container.encode(id.uuidString.lowercased(), forKey: .id)
            case .unknown: try container.encode("unknown", forKey: .kind)
            case .media: try container.encode("media", forKey: .kind)
            }
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: Keys.self)
            switch try container.decode(String.self, forKey: .kind) {
            case "person": self = .person(try container.decode(UUID.self, forKey: .personId))
            case "new":
                self = .new(
                    name: try container.decode(String.self, forKey: .name),
                    personId: try container.decode(UUID.self, forKey: .id))
            case "media": self = .media
            default: self = .unknown
            }
        }
    }
}
