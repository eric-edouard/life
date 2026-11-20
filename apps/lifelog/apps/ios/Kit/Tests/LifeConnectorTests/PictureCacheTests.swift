import Foundation
import Testing

@testable import LifeConnector

private let kept = "00000000000000000000000000000a02"
private let gone = "00000000000000000000000000000b01"

private func folder() -> URL { URL.temporaryDirectory.appending(path: "pictures-\(UUID().uuidString)") }

@MainActor @Test func aPictureIsAskedOnceThenReadFromDisk() async throws {
    let life = FakeLife()
    let directory = folder()
    let cache = PictureCache(directory: directory, api: life)
    await cache.want([kept, gone, "../not-an-id"])
    await cache.want([kept, gone])
    #expect(life.pictureCalls.withLock { $0.map(Set.init) } == [[kept, gone]])
    #expect(cache.shown[kept] == Data([0xFF, 0xD8, 0xFF, 0xD9]))
    #expect(cache.shown[gone] == nil)

    // The extension's cache: no Life, only what the app kept.
    let extensionCache = PictureCache(directory: directory)
    await extensionCache.want([kept, gone])
    #expect(extensionCache.shown[kept] == cache.shown[kept])
}

@MainActor @Test func aFailedCallIsAskedAgainAndManyIdsGoInBatches() async {
    let life = FakeLife()
    life.picturesDown.withLock { $0 = true }
    let cache = PictureCache(directory: folder(), api: life)
    let ids = (0..<(PictureCache.batch + 1)).map { String(format: "%032x", $0) }
    await cache.want(ids)
    #expect(life.pictureCalls.withLock { $0.map(\.count) } == [PictureCache.batch, 1])
    await cache.want(ids)
    #expect(life.pictureCalls.withLock { $0.count } == 4)
}
