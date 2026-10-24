import CryptoKit
import Foundation
import Library

public enum ExportFormat: String, Sendable, CaseIterable {
    case txt
    case markdown
    case srt
    case vtt
    case json

    public var fileName: String {
        switch self {
        case .txt: "transcript.txt"
        case .markdown: "transcript.md"
        case .srt: "captions.srt"
        case .vtt: "captions.vtt"
        case .json: "conversation.json"
        }
    }
}

/// `manifest.json` at the root of every export. See docs/formats.md.
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

    public struct Item: Codable, Sendable, Equatable {
        /// The conversation id, as in its `conversation.json`.
        public var id: String
        public var folder: String
        public var startCaptureMs: Int64
        public var endCaptureMs: Int64
        public var files: [File]
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
    public var items: [Item]
    /// Files outside the item folders, other than the manifest (backup only): its JSON files and stores.
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
    /// The app encodes these with AVFoundation into the item folder before `write`; both start at the item's
    /// range start and run linearly, with silence where nothing was recorded.
    public static let compressedAudio = "audio.m4a"
    public static let wavAudio = "audio.wav"

    /// "2026-10-08 1432": names an export or a backup readably, sorting by time.
    public static func stamp(_ date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return String(
            format: "%04d-%02d-%02d %02d%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0, parts.hour ?? 0,
            parts.minute ?? 0)
    }

    /// "2026-10-07 09.12.03 Lunch with Mai", in the export's time zone.
    /// ponytail: two items starting in the same second with the same title would share a folder.
    public static func folderName(for item: ConversationExport) -> String {
        let forbidden = CharacterSet(charactersIn: "/\\:?*\"<>|").union(.controlCharacters).union(.newlines)
        let title = String(item.title.unicodeScalars.filter { !forbidden.contains($0) }.prefix(60))
            .trimmingCharacters(in: .whitespaces)
        let time = item.clock(item.range.lowerBound).replacing(":", with: ".")
        return "\(item.day(item.range.lowerBound)) \(time) \(title)"
    }

    /// Writes the chosen text formats into one folder per item, hashes every file in those folders (including
    /// audio the app placed there), adds the backup files, and writes `manifest.json` last.
    @discardableResult
    public static func write(
        _ items: [ConversationExport], formats: Set<ExportFormat>, to root: URL, appVersion: String, createdAt: Date,
        backup: BackupContents? = nil, unsupported: [Manifest.Unsupported] = []
    ) throws -> Manifest {
        let files = FileManager.default
        var entries: [Manifest.Item] = []
        for item in items {
            let folder = folderName(for: item)
            let url = root.appending(path: folder, directoryHint: .isDirectory)
            try files.createDirectory(at: url, withIntermediateDirectories: true)
            for format in ExportFormat.allCases where formats.contains(format) {
                let text =
                    switch format {
                    case .txt: item.plainText()
                    case .markdown: item.markdown()
                    case .srt: item.srt()
                    case .vtt: item.vtt()
                    case .json: try item.json()
                    }
                try Data(text.utf8).write(to: url.appending(path: format.fileName), options: .atomic)
            }
            let names = try files.contentsOfDirectory(atPath: url.path).sorted()
            entries.append(
                Manifest.Item(
                    id: item.conversation.id.uuidString.lowercased(), folder: folder,
                    startCaptureMs: item.range.lowerBound.millis, endCaptureMs: item.range.upperBound.millis,
                    files: try names.map { try entry(root, "\(folder)/\($0)") }))
        }
        if let backup {
            try ConversationDocument.encoder.encode(backup.sources).write(
                to: root.appending(path: "sources.json"), options: .atomic)
        }
        // Everything else under the root (a backup's stores), so every byte shipped is listed and hashed.
        let itemPaths = Set(entries.flatMap(\.files).map(\.path))
        let rootFiles = try Self.files(under: root).filter { !itemPaths.contains($0) && $0 != "manifest.json" }
            .map { try entry(root, $0) }
        let manifest = Manifest(
            format: Manifest.format, version: Manifest.currentVersion, kind: backup == nil ? .export : .backup,
            appVersion: appVersion, createdAt: createdAt, items: entries, files: rootFiles, unsupported: unsupported)
        try ConversationDocument.encoder.encode(manifest).write(
            to: root.appending(path: "manifest.json"), options: .atomic)
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
