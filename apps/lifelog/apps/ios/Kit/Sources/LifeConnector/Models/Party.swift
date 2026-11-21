import Foundation
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

    /// The owner himself, as every read names him (`OWNER`, `memory/read-truth.ts`).
    public var isOwner: Bool { ref == "person:me" }
}

/// A read that names parties: the phone keeps each by its ref (`LifeStore.parties`) and fetches their pictures.
public protocol NamesParties {
    var parties: [Party] { get }
}

/// A read's answer text as its value: JSON (`feedDecoder`) for every read but a prose part (`Prose`).
public protocol ParsedRead: Sendable {
    static func parsed(_ text: String) throws -> Self
}

extension ParsedRead where Self: Decodable {
    public static func parsed(_ text: String) throws -> Self {
        try LibraryStore.feedDecoder.decode(Self.self, from: Data(text.utf8))
    }
}

/// A read Life versions (`read_inbox`, `read_matters`, `read_projects`, `read_project`): asked again with `ifNot` its
/// `version` (nil in a read kept before Life sent one), Life answers only `{version, unchanged: true}` while nothing
/// changed.
public protocol VersionedRead {
    var version: String? { get }
}

extension VersionedRead {
    /// Whether `text`, read with `ifNot` this read's version, says nothing changed: this read holds.
    public func isUnchanged(by text: String) -> Bool {
        guard let version, let answer = try? JSONDecoder().decode(Unchanged.self, from: Data(text.utf8)) else {
            return false
        }
        return answer.unchanged && answer.version == version
    }
}

/// Life's answer to a versioned read asked `ifNot` its version, while nothing changed.
private struct Unchanged: Decodable {
    let unchanged: Bool
    let version: String
}

extension Inbox: ParsedRead, VersionedRead {}
extension MatterList: ParsedRead, VersionedRead {}
extension ProjectChips: VersionedRead {}
extension ProjectHeader: VersionedRead {}
extension Matter: ParsedRead {}
extension RegisteredAgents: ParsedRead {}
extension PeopleList: ParsedRead {}
extension PersonNow: ParsedRead {}

extension Check: NamesParties {
    public var parties: [Party] {
        likelyPeople + [networkIdentity?.party].compactMap(\.self) + (confirm ?? []).flatMap(\.parties)
    }
}

extension Inbox: NamesParties {
    public var parties: [Party] { checks.flatMap(\.parties) }
}

extension MatterRow: NamesParties {
    public var parties: [Party] {
        [people?.owedTo, people?.waitingOn, people?.with, people?.told].flatMap { $0 ?? [] }
    }
}

extension MatterList: NamesParties {
    public var parties: [Party] { matters.flatMap(\.parties) }
}

extension Matter: NamesParties {
    public var parties: [Party] {
        row.parties + steps.compactMap(\.with) + checks.flatMap(\.parties) + agents.flatMap(\.parties)
    }
}

extension RegisteredAgent: NamesParties {
    public var parties: [Party] {
        wakesOn.compactMap { if case .message(let message) = $0 { message.party } else { nil } }
    }
}

extension RegisteredAgents: NamesParties {
    public var parties: [Party] { agents.flatMap(\.parties) }
}
