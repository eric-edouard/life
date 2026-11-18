import CryptoKit
import Foundation
import Library

/// `manifest.json` at the root of every backup. See docs/formats.md.
public struct Manifest: Codable, Sendable, Equatable {
    public static let format = "lifelog-export"
    public static let currentVersion = 1

    public enum Kind: String, Codable, Sendable {
        case export
        /// The full private backup: adds source references at the root.
        case backup
    }

    public struct File: Codable, Sendable, Equatable {
        /// Relative to the export root.
        public var path: String
        public var bytes: Int64
        public var sha256: String
    }

    /// Something asked for but not in this export, said out loud rather than silently dropped.
    public struct Unsupported: Codable, Sendable, Equatable {
        public var item: String?
        public var what: String
        public var reason: String

        public init(item: String?, what: String, reason: String) {
            self.item = item
            self.what = what
            self.reason = reason
        }
    }

    public var format: String
    public var version: Int
    public var kind: Kind
    public var appVersion: String
    public var createdAt: Date
    /// Every file under the root other than the manifest: its JSON files and stores.
    public var files: [File]
    public var unsupported: [Unsupported]
}

/// Where a backup's raw pages live. The pack file itself sits at `path` inside the backup.
public struct SourceReference: Codable, Sendable, Equatable {
    public var deviceId: String
    public var firstPageIndex: UInt64
    public var lastPageIndex: UInt64
    public var path: String

    public init(deviceId: String, firstPageIndex: UInt64, lastPageIndex: UInt64, path: String) {
        self.deviceId = deviceId
        self.firstPageIndex = firstPageIndex
        self.lastPageIndex = lastPageIndex
        self.path = path
    }
}

/// What the full private backup adds.
public struct BackupContents: Sendable {
    public var sources: [SourceReference]

    public init(sources: [SourceReference]) {
        self.sources = sources
    }
}

public enum ExportPackage {
    /// "2026-10-08 1432": names an export or a backup readably, sorting by time.
    public static func stamp(_ date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return String(
            format: "%04d-%02d-%02d %02d%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0, parts.hour ?? 0,
            parts.minute ?? 0)
    }

    /// Hashes every file under the root, adds the backup's `sources.json`, and writes `manifest.json` last.
    @discardableResult
    public static func write(
        to root: URL, appVersion: String, createdAt: Date, backup: BackupContents,
        unsupported: [Manifest.Unsupported] = []
    ) throws -> Manifest {
        try Manifest.encoder.encode(backup.sources).write(to: root.appending(path: "sources.json"), options: .atomic)
        let rootFiles = try Self.files(under: root).filter { $0 != "manifest.json" }.map { try entry(root, $0) }
        let manifest = Manifest(
            format: Manifest.format, version: Manifest.currentVersion, kind: .backup, appVersion: appVersion,
            createdAt: createdAt, files: rootFiles, unsupported: unsupported)
        try Manifest.encoder.encode(manifest).write(to: root.appending(path: "manifest.json"), options: .atomic)
        return manifest
    }

    /// Zips a written export with the system: a coordinated read `.forUploading` of a directory yields a ZIP of it
    /// (Foundation, iOS 8+ and macOS), so no ZIP code or dependency is needed. The archive holds the root folder.
    public static func zip(_ directory: URL, to destination: URL) throws {
        var coordinationError: NSError?
        var copyError: (any Error)?
        NSFileCoordinator().coordinate(readingItemAt: directory, options: .forUploading, error: &coordinationError) {
            do { try FileManager.default.copyItem(at: $0, to: destination) } catch { copyError = error }
        }
        if let error = coordinationError ?? copyError { throw error }
    }

    /// Relative paths of the regular files under `root`, sorted.
    static func files(under root: URL) throws -> [String] {
        let enumerator = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.isRegularFileKey], options: [.producesRelativePathURLs])
        var paths: [String] = []
        while let url = enumerator?.nextObject() as? URL {
            if try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
                paths.append(url.relativePath)
            }
        }
        return paths.sorted()
    }

    static func entry(_ root: URL, _ path: String) throws -> Manifest.File {
        let (bytes, digest) = try sha256(of: root.appending(path: path))
        return Manifest.File(path: path, bytes: bytes, sha256: digest)
    }

    /// Streams the file, so large audio is never read whole.
    static func sha256(of url: URL) throws -> (bytes: Int64, hex: String) {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        var bytes: Int64 = 0
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
            bytes += Int64(chunk.count)
        }
        return (bytes, hasher.finalize().map { String(format: "%02x", $0) }.joined())
    }
}

extension Manifest {
    /// Sorted keys and ISO 8601 dates, so the same input always gives the same bytes.
    static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
