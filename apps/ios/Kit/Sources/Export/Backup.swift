import Foundation
import Library
import SourceStore

/// The full private backup: the app's stores as they are, so a restore loses nothing. Separate from ordinary exports.
///
/// The backup holds, under `stores/`, the same layout as the app's `Application Support/lifelog` folder: the source
/// store (`source/source.sqlite` receipts and `source/packs/*.pack` raw pages), `library/library.sqlite`,
/// `timeline.sqlite` (the scanned timeline, and the old pipeline's parts the backup of old jobs' audio reads), the derived sidecars
/// `derived/<device>/*.json` and the audio of recordings imported from the old app, `library/imported/*.m4a`, which nothing could rebuild. Derived audio is left out: it is rebuilt from the packs.
/// `upload/upload.sqlite` is left out too: a restore starts the uploads over around the server's pages, as a reinstall
/// does. Every file is listed in the manifest with its size and SHA-256.
public enum Backup {
    static let databases = ["source/source.sqlite", "library/library.sqlite", "timeline.sqlite"]

    /// Backs up the stores under `live` (the app's Life folder) into `root`. Only reads `live`, and capture may
    /// keep writing meanwhile: databases are copied first as consistent snapshots (`VACUUM INTO`), and packs only
    /// ever grow, so every receipt in the snapshot points at bytes already in the packs copied after it.
    @concurrent @discardableResult
    public static func write(
        from live: URL, to root: URL, appVersion: String, createdAt: Date
    ) async throws -> Manifest {
        let files = FileManager.default
        let stores = root.appending(path: "stores", directoryHint: .isDirectory)
        for path in databases where files.fileExists(atPath: live.appending(path: path).path) {
            let destination = stores.appending(path: path)
            try files.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try SQLite(path: live.appending(path: path).path, readOnly: true)
                .execute("VACUUM INTO '\(destination.path.replacing("'", with: "''"))'")
        }
        for path in try ExportPackage.files(under: live) where isCopied(path) {
            try Task.checkCancellation()
            let destination = stores.appending(path: path)
            try files.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try files.copyItem(at: live.appending(path: path), to: destination)
        }
        let contents = BackupContents(sources: try packs(stores.appending(path: "source/source.sqlite")))
        return try ExportPackage.write(
            [], formats: [], to: root, appVersion: appVersion, createdAt: createdAt, backup: contents)
    }

    /// The backup as one ZIP in `work`, for the share sheet. The unzipped folder is removed, so the stores are
    /// copied once more at most.
    @concurrent
    public static func archive(from live: URL, in work: URL, appVersion: String) async throws
        -> URL
    {
        let createdAt = Date.now
        let folder = work.appending(
            path: "lifelog backup \(ExportPackage.stamp(createdAt, timeZone: .current))", directoryHint: .isDirectory)
        try await write(from: live, to: folder, appVersion: appVersion, createdAt: createdAt)
        let zip = work.appending(path: "\(folder.lastPathComponent).zip")
        try ExportPackage.zip(folder, to: zip)
        try FileManager.default.removeItem(at: folder)
        return zip
    }

    private static func isCopied(_ path: String) -> Bool {
        (path.hasPrefix("source/packs/") && path.hasSuffix(".pack"))
            || (path.hasPrefix("derived/") && path.hasSuffix(".json"))
            || (path.hasPrefix("library/imported/") && path.hasSuffix(".m4a"))
    }

    /// Which pages each pack holds, from the receipts snapshot.
    private static func packs(_ receipts: URL) throws -> [SourceReference] {
        guard FileManager.default.fileExists(atPath: receipts.path) else { return [] }
        return try SQLite(path: receipts.path).query(
            """
            SELECT CAST(device_id AS BLOB), pack_id, MIN(page_index), MAX(page_index) FROM receipts
            GROUP BY device_id, pack_id ORDER BY device_id, pack_id
            """
        ) {
            SourceReference(
                deviceId: String(decoding: $0.blob(0), as: UTF8.self), firstPageIndex: UInt64($0.int(2)),
                lastPageIndex: UInt64($0.int(3)), path: "stores/source/packs/\($0.int(1)).pack")
        }
    }
}
