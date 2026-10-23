import Foundation
import Library
import Timeline

/// What the owner asked for in the export sheet.
/// PDF is not in v1; the sheet says so instead of offering it.
public struct ExportRequest: Sendable {
    public var conversations: [UUID]
    public var audio: Set<AudioFormat>
    public var text: Set<ExportFormat>

    public init(conversations: [UUID], audio: Set<AudioFormat>, text: Set<ExportFormat>) {
        self.conversations = conversations
        self.audio = audio
        self.text = text
    }
}

public struct ExportResult: Sendable {
    /// The export folder (lifelog-export v1).
    public var folder: URL
    /// What to hand the share sheet: the only file when there is just one, else a ZIP of the folder.
    public var share: URL
    public var manifest: Manifest
}

/// An ordinary export, end to end. Only reads the library and the derived audio: it never transcribes, generates
/// or uploads anything, and never includes voice embeddings (the library holds none).
public enum ExportJob {
    public static func run(
        _ request: ExportRequest, library: LibraryStore, audio sources: [AudioSource], timeZone: TimeZone,
        appVersion: String, in work: URL, progress: @escaping @Sendable (Double) -> Void = { _ in }
    ) async throws -> ExportResult {
        var unsupported: [Manifest.Unsupported] = []
        var items: [ConversationExport] = []
        for id in request.conversations {
            if let item = try await ConversationExport.load(id, from: library, audio: sources, timeZone: timeZone) {
                items.append(item)
            } else {
                unsupported.append(
                    .init(item: id.uuidString.lowercased(), what: "conversation", reason: "Not in the library."))
            }
        }
        let createdAt = Date.now
        let folder = work.appending(path: "Life export \(ExportPackage.stamp(createdAt, timeZone: timeZone))")
        for (index, item) in items.enumerated() where !request.audio.isEmpty {
            let itemFolder = folder.appending(path: ExportPackage.folderName(for: item), directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: itemFolder, withIntermediateDirectories: true)
            let outputs = Dictionary(
                uniqueKeysWithValues: request.audio.map { ($0, itemFolder.appending(path: $0.fileName)) })
            let count = Double(items.count)
            try await RangeAudio.write(item.range, from: sources, to: outputs) {
                progress((Double(index) + $0) / count)
            }
        }
        let manifest = try ExportPackage.write(
            items, formats: request.text, to: folder, appVersion: appVersion, createdAt: createdAt,
            unsupported: unsupported)
        progress(1)
        let files = manifest.items.flatMap(\.files)
        if files.count == 1, let only = files.first, let item = manifest.items.first {
            let named = work.appending(path: "\(item.folder) \(only.path.split(separator: "/").last ?? "")")
            try FileManager.default.copyItem(at: folder.appending(path: only.path), to: named)
            return ExportResult(folder: folder, share: named, manifest: manifest)
        }
        let zip = work.appending(path: "\(folder.lastPathComponent).zip")
        try ExportPackage.zip(folder, to: zip)
        return ExportResult(folder: folder, share: zip, manifest: manifest)
    }
}
