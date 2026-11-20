import Foundation
import Synchronization
import Testing

@testable import LifeConnector

/// A Life that answers `read_person_pictures` with the wire fixture, or fails while `isDown`, and counts its calls.
private final class PictureLife: LifeAPI, @unchecked Sendable {
    let calls = Mutex<[[String]]>([])
    let isDown = Mutex(false)

    func readPersonPictures(_ ids: [String]) async throws -> String {
        calls.withLock { $0.append(ids) }
        if isDown.withLock({ $0 }) { throw MCPError.unreachable }
        return try wireText("life/read_person_pictures.json")
    }

    func readInbox() async throws -> String { "{}" }
    func readInbox(pushId: String) async throws -> String { "{}" }
    func readMatters() async throws -> String { "{}" }
    func readMatter(_ id: String) async throws -> String { "{}" }
    func readRegisteredAgents() async throws -> String { "{}" }
    func answerCheck(_ answer: AnswerRequest, answerKey: String, onProgress: @escaping @Sendable (Data) -> Void)
        async throws -> String
    { "" }
    func changeAgent(_ change: AgentRequest, onProgress: @escaping @Sendable (Data) -> Void) async throws -> String {
        ""
    }
    func setMatterDirection(
        matter: String, goal: String?, nextStep: NextStepRequest?, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String { "" }
    func markDone(matter: String, note: String, onProgress: @escaping @Sendable (Data) -> Void) async throws -> String {
        ""
    }
}

private let kept = "00000000000000000000000000000a02"
private let gone = "00000000000000000000000000000b01"

private func folder() -> URL { URL.temporaryDirectory.appending(path: "pictures-\(UUID().uuidString)") }

@MainActor @Test func aPictureIsAskedOnceThenReadFromDisk() async throws {
    let life = PictureLife()
    let directory = folder()
    let cache = PictureCache(directory: directory, api: life)
    await cache.want([kept, gone, "../not-an-id"])
    await cache.want([kept, gone])
    #expect(life.calls.withLock { $0.map(Set.init) } == [[kept, gone]])
    #expect(cache.shown[kept] == Data([0xFF, 0xD8, 0xFF, 0xD9]))
    #expect(cache.shown[gone] == nil)

    // The extension's cache: no Life, only what the app kept.
    let extensionCache = PictureCache(directory: directory)
    await extensionCache.want([kept, gone])
    #expect(extensionCache.shown[kept] == cache.shown[kept])
}

@MainActor @Test func aFailedCallIsAskedAgainAndManyIdsGoInBatches() async {
    let life = PictureLife()
    life.isDown.withLock { $0 = true }
    let cache = PictureCache(directory: folder(), api: life)
    let ids = (0..<(PictureCache.batch + 1)).map { String(format: "%032x", $0) }
    await cache.want(ids)
    #expect(life.calls.withLock { $0.map(\.count) } == [PictureCache.batch, 1])
    await cache.want(ids)
    #expect(life.calls.withLock { $0.count } == 4)
}
