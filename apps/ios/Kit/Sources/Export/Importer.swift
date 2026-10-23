import Foundation
import Library

public enum ImportError: Error, Equatable {
    case notAnExport
    /// Written by a newer app. Fail closed rather than guess at a format we don't know.
    case unsupportedVersion(Int)
    case missingFile(String)
    case hashMismatch(String)
    case invalid(item: String, reason: String)
    /// Restore takes only a full private backup (`kind: "backup"`).
    case notABackup
}

/// What a check of an export folder found: its manifest, and what it holds that was not imported.
public struct ImportPlan: Sendable {
    public var manifest: Manifest
    public var unsupported: [Manifest.Unsupported]
}

/// Reads an unpacked lifelog-export v1 folder (iOS Files unzips a ZIP; this takes the folder): the manifest, and every
/// file listed in it against its size and SHA-256. A backup's restore (`Restore.swift`) goes on from here.
public enum Importer {
    public static func plan(_ root: URL) throws -> ImportPlan {
        let manifest = try readManifest(root)
        let listed = manifest.items.flatMap(\.files) + manifest.files
        for file in listed {
            // A path is only ever read below the root, and a restore writes it below its own area.
            guard !file.path.hasPrefix("/"), !file.path.split(separator: "/").contains("..") else {
                throw ImportError.invalid(item: file.path, reason: "path leaves the export")
            }
            let url = root.appending(path: file.path)
            guard FileManager.default.fileExists(atPath: url.path) else { throw ImportError.missingFile(file.path) }
            guard try ExportPackage.sha256(of: url) == (file.bytes, file.sha256) else {
                throw ImportError.hashMismatch(file.path)
            }
        }
        var plan = ImportPlan(manifest: manifest, unsupported: manifest.unsupported)
        let listedPaths = Set(listed.map(\.path) + ["manifest.json"])
        for path in try ExportPackage.files(under: root) where !listedPaths.contains(path) {
            plan.unsupported.append(.init(item: nil, what: path, reason: "Not listed in the manifest; ignored."))
        }
        return plan
    }

    private static func readManifest(_ root: URL) throws -> Manifest {
        struct Header: Decodable {
            var format: String?
            var version: Int?
        }
        let url = root.appending(path: "manifest.json")
        guard let data = try? Data(contentsOf: url) else { throw ImportError.missingFile("manifest.json") }
        let header = try? JSONDecoder().decode(Header.self, from: data)
        guard header?.format == Manifest.format, let version = header?.version else { throw ImportError.notAnExport }
        guard version == Manifest.currentVersion else { throw ImportError.unsupportedVersion(version) }
        return try ConversationDocument.decoder.decode(Manifest.self, from: data)
    }

    static func read<T: Decodable>(_ type: T.Type, _ root: URL, _ path: String) throws -> T {
        try ConversationDocument.decoder.decode(type, from: Data(contentsOf: root.appending(path: path)))
    }
}
