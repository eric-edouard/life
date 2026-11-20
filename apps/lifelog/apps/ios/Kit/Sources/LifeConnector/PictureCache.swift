import Foundation
import Observation

/// The pictures people and organizations show (`read_person_pictures`), on disk by id in the app group's caches, so the
/// notification extension draws the ones the app kept. An id names one picture's bytes, so a kept file is never stale
/// and is kept for good (the system may clear caches; a picture then comes again). Only the app fetches (`api`).
@MainActor @Observable
public final class PictureCache {
    /// The pictures on hand, by id: what a disc draws.
    public private(set) var shown: [String: Data] = [:]

    @ObservationIgnored private let directory: URL
    @ObservationIgnored private let api: (any LifeAPI)?
    /// Ids asked of Life since launch, so a picture Life does not have is asked once, not on every read.
    @ObservationIgnored private var asked: Set<String> = []

    /// At most this many ids in one call (`MAX_IDS`, `host/http/mcp-people.ts`).
    static let batch = 64

    public init(directory: URL, api: (any LifeAPI)? = nil) {
        self.directory = directory
        self.api = api
    }

    /// Puts the pictures `ids` name on hand: from disk, else from Life, in as few calls as the batch allows. A call that
    /// fails leaves its ids to the next want.
    public func want(_ ids: some Sequence<String>) async {
        var missing: [String] = []
        for id in Set(ids) where shown[id] == nil && !asked.contains(id) && Self.isPictureID(id) {
            if let data = try? Data(contentsOf: file(id)) { shown[id] = data } else { missing.append(id) }
        }
        guard let api, !missing.isEmpty else { return }
        asked.formUnion(missing)
        for start in stride(from: 0, to: missing.count, by: Self.batch) {
            let ids = Array(missing[start..<min(start + Self.batch, missing.count)])
            guard let text = try? await api.readPersonPictures(ids),
                let read = try? JSONDecoder().decode(Read.self, from: Data(text.utf8))
            else {
                asked.subtract(ids)
                continue
            }
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            for picture in read.pictures where ids.contains(picture.id) {
                try? picture.data.write(to: file(picture.id), options: .atomic)
                shown[picture.id] = picture.data
            }
        }
    }

    private func file(_ id: String) -> URL { directory.appending(path: id + ".jpg") }

    /// A picture's id is its bytes' digest, 32 hex digits: never a path.
    private static func isPictureID(_ id: String) -> Bool { id.count == 32 && id.allSatisfy(\.isHexDigit) }

    /// `read_person_pictures`'s answer: `data` is base64, which `Data` decodes as is.
    private struct Read: Decodable {
        struct Picture: Decodable {
            let id: String
            let data: Data
        }
        let pictures: [Picture]
    }
}
