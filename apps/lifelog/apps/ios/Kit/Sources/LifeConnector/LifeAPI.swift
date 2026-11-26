import Foundation
import Library

/// His mark on how Life did (`MARKS`, `memory/decision-lines.ts`).
public enum RatingMark: String, UnknownTolerant, Encodable, Sendable {
    case bad, okay, good
    case unknown
}

/// His answer to one check (`answer_check`'s arguments).
public struct AnswerRequest: Encodable, Sendable, Equatable {
    public var ref: String
    public var options: [String]
    public var note: String?
    public var person: String?
    public var name: String?
    /// His Undo of an answer he gave (`answer_check`'s `undo`): no options.
    public var undo: Bool?
    /// His mark on how Life did on an answered card ("How am I doing?"): one `rated` line, no options.
    public var rate: RatingMark?

    public init(
        ref: String, options: [String], note: String? = nil, person: String? = nil, name: String? = nil,
        undo: Bool? = nil, rate: RatingMark? = nil
    ) {
        (self.ref, self.options, self.note) = (ref, options, note)
        (self.person, self.name, self.undo, self.rate) = (person, name, undo, rate)
    }

    /// His mark on how Life did on the answered card `ref`.
    public static func rating(_ ref: String, _ mark: RatingMark) -> Self { Self(ref: ref, options: [], rate: mark) }

    /// His Later on an ask: Life picks until when.
    public static func later(_ ref: String) -> Self { Self(ref: ref, options: ["later"]) }
    public var isUndo: Bool { undo == true }
    public static func undoing(_ ref: String) -> Self { Self(ref: ref, options: [], undo: true) }
}

/// Life's connector, typed: the one place tool names appear. Each gives the tool's JSON text, which `LibraryStore.feedDecoder` reads into
/// the models and `ReadCache` keeps as it came. An action gives its progress messages to `onProgress` and takes the key of his tap.
/// The versioned reads (`VersionedRead`) take `ifNot`, the version held: Life then answers only `{version, unchanged:
/// true}` while nothing changed.
public protocol LifeAPI: Sendable {
    /// The card a push names, from the Life at `origin` (nil: the one paired now).
    func readInbox(pushId: String, at origin: URL?) async throws -> String
    /// A page of his thread, newest 3 days first (`before`: the page `earlier` named); `ifNot` the version held.
    func readThread(before: String?, ifNot: String?) async throws -> String
    /// What a `life:` link names, opened by its ref: Life's text, or a person's read as JSON (`LifeLinkRead`).
    func fetch(_ ref: String) async throws -> String
    /// The pictures these ids name (a party's `picture.id`), at most 64 (`PictureCache`).
    func readPersonPictures(_ ids: [String]) async throws -> String
    /// One part of a read by its ref (`person:<id>/now`, `…/latest/before/<day>`, `…/page`), as `fetch` opens it.
    func readPart(_ ref: String) async throws -> String

    /// A matter in full (`read_matter`), as `Matter`: its page.
    func readMatter(_ id: String) async throws -> String
    /// His directory: everyone with a page, as `PeopleList` (`read_people_and_organizations` with no name).
    func readPeople() async throws -> String

    /// His answer, to the Life it was decided for (`origin`, a `PairedLife`'s) and no other.
    func answerCheck(
        _ answer: AnswerRequest, answerKey: String, at origin: URL, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String
    /// An appointment Life added to his calendar, by its push's `pushId` or its own id (one of the two), from the Life at
    /// `origin` (nil: the one paired now).
    func readAppointment(_ key: AppointmentKey, at origin: URL?) async throws -> String
    /// His Remove (`isOn` false) or Undo (`isOn` true) of one, from the Life at `origin`.
    func changeAppointment(_ appointment: String, isOn: Bool, at origin: URL?) async throws -> String
    /// Ask Life (`ask_main_session`): his words, his Stop, his reaction or his presence. The lines of an ask stream to
    /// `onProgress`; the call ends on its answer.
    func askMainSession(
        _ request: MainSessionRequest, answerKey: String?, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String
}

/// How `read_appointments` names one: by its push's id, or its own.
public enum AppointmentKey: Sendable, Hashable, Identifiable {
    case pushId(String)
    case appointment(String)

    public var id: String {
        switch self {
        case .pushId(let id): "push-\(id)"
        case .appointment(let id): id
        }
    }
}

public struct MCPLifeAPI: LifeAPI {
    private let client: MCPClient

    public init(client: MCPClient) {
        self.client = client
    }

    /// Only the card a push names (none once answered), with the inbox's counts: what a notification reads.
    public func readInbox(pushId: String, at origin: URL?) async throws -> String {
        try await client.call("read_inbox", ["pushId": pushId], at: origin)
    }
    public func readThread(before: String?, ifNot: String?) async throws -> String {
        var arguments: [String: String] = [:]
        if let before { arguments["before"] = before }
        if let ifNot { arguments["ifNot"] = ifNot }
        return try await client.call("read_thread", arguments)
    }
    public func fetch(_ ref: String) async throws -> String { try await client.call("fetch", ["id": ref]) }
    public func readPersonPictures(_ ids: [String]) async throws -> String {
        try await client.call("read_person_pictures", ["ids": ids])
    }
    public func readPart(_ ref: String) async throws -> String { try await client.call("fetch", ["id": ref]) }
    public func readMatter(_ id: String) async throws -> String { try await client.call("read_matter", ["id": id]) }
    public func readPeople() async throws -> String {
        try await client.call("read_people_and_organizations", [String: String]())
    }

    public func answerCheck(
        _ answer: AnswerRequest, answerKey: String, at origin: URL, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String {
        try await client.call("answer_check", answer, answerKey: answerKey, at: origin, onProgress: onProgress)
    }

    public func readAppointment(_ key: AppointmentKey, at origin: URL?) async throws -> String {
        let arguments =
            switch key {
            case .pushId(let id): ["pushId": id]
            case .appointment(let id): ["appointment": id]
            }
        return try await client.call("read_appointments", arguments, at: origin)
    }

    public func changeAppointment(_ appointment: String, isOn: Bool, at origin: URL?) async throws -> String {
        try await client.call(
            "change_appointment", ["action": isOn ? "restore" : "remove", "appointment": appointment], at: origin)
    }

    public func askMainSession(
        _ request: MainSessionRequest, answerKey: String?, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String {
        // Even his presence takes the stream's 15 s idle limit: a cold session opens in about 8.
        try await client.call("ask_main_session", request, answerKey: answerKey, onProgress: onProgress)
    }
}
