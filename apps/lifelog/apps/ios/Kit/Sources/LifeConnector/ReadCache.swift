import Foundation

/// The last good answer of each read, as the tool's JSON text, one file per key: a cold start with no Mac in reach
/// still has something to show (as stale). Out of backups, like the library's derived files; a file it cannot read is
/// as if there were none.
public struct ReadCache: Sendable {
    private let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    private func file(_ key: String) -> URL {
        // A key is a read's name, plus a matter's id: never a path.
        directory.appending(path: key.replacing(/[^A-Za-z0-9_.-]/, with: "_") + ".json")
    }

    /// Keeps `text` as read at `asked`, when its read was asked: the date a cold start shows it as.
    public func store(_ text: String, key: String, asked: Date = Date()) {
        var folder = directory
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var excluded = URLResourceValues()
        excluded.isExcludedFromBackup = true
        try? folder.setResourceValues(excluded)
        try? Data(text.utf8).write(to: file(key), options: .atomic)
        try? FileManager.default.setAttributes([.modificationDate: asked], ofItemAtPath: file(key).path)
    }

    /// The text kept and when its read was asked.
    public func load(_ key: String) -> (text: String, at: Date)? {
        let url = file(key)
        guard let data = try? Data(contentsOf: url),
            let at = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        else { return nil }
        return (String(decoding: data, as: UTF8.self), at)
    }

    /// When the oldest read kept was asked, `except` one key (a file that is not a read); nil when none is kept.
    public func oldest(except key: String) -> Date? {
        let files =
            (try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        return files.filter { $0.lastPathComponent != file(key).lastPathComponent }.compactMap {
            try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        }.min()
    }

    public func clear() { try? FileManager.default.removeItem(at: directory) }
}
