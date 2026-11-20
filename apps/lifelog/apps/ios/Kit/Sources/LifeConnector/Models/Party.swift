import Library

/// Someone Life has a ref for, a person or an organization, as every read names them (`Party`, `memory/party.ts`).
public struct Party: Decodable, Sendable, Equatable {
    public enum Kind: String, UnknownTolerant, Sendable {
        case person, organization
        case unknown
    }

    /// A picture they show, fetched by its id (`read_person_pictures`).
    public struct Picture: Decodable, Sendable, Equatable {
        public let id: String
    }

    public let ref: String
    public let name: String
    public let kind: Kind
    /// What they are to him, one line, when Life knows it.
    public let line: String?
    public let picture: Picture?
}
