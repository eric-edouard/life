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

    public func store(_ text: String, key: String) {
        var folder = directory
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var excluded = URLResourceValues()
        excluded.isExcludedFromBackup = true
        try? folder.setResourceValues(excluded)
        try? Data(text.utf8).write(to: file(key), options: .atomic)
    }

    /// The text kept and when it was kept.
    public func load(_ key: String) -> (text: String, at: Date)? {
        let url = file(key)
        guard let data = try? Data(contentsOf: url),
            let at = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        else { return nil }
        return (String(decoding: data, as: UTF8.self), at)
    }

    public func clear() { try? FileManager.default.removeItem(at: directory) }
}
