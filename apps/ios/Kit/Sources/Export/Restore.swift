import AudioPipeline
import Foundation
import Library
import SourceStore
import Timeline

/// Switching the app to a restored backup. The owner picks a folder `Importer.restore` wrote; the switch happens at the
/// next launch, before any store opens, so nothing holds the live stores while their folder moves.
public struct LibrarySwitch: Sendable {
    public enum Outcome: Sendable, Equatable {
        /// The restored library is live. The one it replaced is kept at `previous` (none on a fresh install).
        case switched(previous: URL?)
        /// The current library stays live (unless the reason says it could not be put back, and where it is).
        case failed(String)
    }

    /// Application Support.
    public let support: URL

    public init(support: URL) {
        self.support = support
    }

    /// The app's stores, as `CaptureStore` and `ProcessingStore` lay them out.
    public var live: URL { support.appending(path: "lifelog", directoryHint: .isDirectory) }
    /// Restored backups, each in its own folder beside (never inside) the live stores.
    public var restores: URL { support.appending(path: "lifelog-restores", directoryHint: .isDirectory) }
    /// Holds the name of the restored folder to switch to at the next launch.
    private var scheduled: URL { support.appending(path: "lifelog-switch-scheduled") }

    /// Readies `restored` (a folder in `restores`) and schedules the switch. Its derived sidecars came back but its
    /// playback audio did not, so every such file is queued in its own source store for the worker to rebuild.
    /// Touches only `restored` and the schedule; the live stores stay open and unchanged.
    @concurrent
    public func schedule(_ restored: URL) async throws {
        let name = restored.lastPathComponent
        guard restored.deletingLastPathComponent().standardizedFileURL == restores.standardizedFileURL,
            name.hasPrefix("backup-")
        else { throw ImportError.invalid(item: name, reason: "not a restored backup") }
        let source = try SourceStore(directory: restored.appending(path: "source", directoryHint: .isDirectory))
        for (device, pages) in try DerivedAudioDirectory(
            url: restored.appending(path: "derived", directoryHint: .isDirectory)
        ).missingAudio() {
            try await source.requeueJob(deviceID: device, indices: pages)
        }
        try Data(name.utf8).write(to: scheduled, options: .atomic)
    }

    /// At launch, before any store opens. Moves the live folder aside to `lifelog-previous-<unix time>`, never deleted,
    /// then the scheduled restored folder into its place. Fails closed: if a step fails, the live folder is put back.
    /// The schedule is consumed either way, so a failing switch doesn't retry at every launch. `nil`: none scheduled.
    public func applyScheduled(now: Date = .now) -> Outcome? {
        let files = FileManager.default
        guard let name = try? String(contentsOf: scheduled, encoding: .utf8) else { return nil }
        do {
            try files.removeItem(at: scheduled)
        } catch {
            return .failed("The scheduled switch could not be cleared: \(error.localizedDescription)")
        }
        let restored = restores.appending(path: name, directoryHint: .isDirectory)
        var isDirectory: ObjCBool = false
        guard name.hasPrefix("backup-"), !name.contains("/"),
            files.fileExists(atPath: restored.path, isDirectory: &isDirectory), isDirectory.boolValue
        else { return .failed("The restored library \(name) is gone.") }

        var previous: URL?
        if files.fileExists(atPath: live.path) {
            let aside = support.appending(
                path: "lifelog-previous-\(Int64(now.timeIntervalSince1970))", directoryHint: .isDirectory)
            do {
                try files.moveItem(at: live, to: aside)
            } catch {
                return .failed("The current library could not be moved aside: \(error.localizedDescription)")
            }
            previous = aside
        }
        do {
            try files.moveItem(at: restored, to: live)
            return .switched(previous: previous)
        } catch {
            let reason = "The restored library could not be moved into place: \(error.localizedDescription)"
            guard let previous else { return .failed(reason) }
            do {
                try files.moveItem(at: previous, to: live)
            } catch {
                return .failed("\(reason) The current library could not be put back; it is in \(previous.path).")
            }
            return .failed(reason)
        }
    }
}

public struct RestoreReport: Sendable, Equatable {
    /// The restored stores, laid out like the app's Life folder.
    public var location: URL
    /// This backup was restored before, so nothing was written.
    public var alreadyRestored: Bool
    public var conversations: Int
    public var pages: Int
    public var unsupported: [Manifest.Unsupported]
}

extension Importer {
    /// Restores a full private backup into a new folder `backup-<manifest hash>` under `area`. It never touches the
    /// live stores and only reads `backup`. Everything is checked before the folder appears: the manifest version
    /// (fail closed), every file's size and SHA-256, the store schemas (fail closed on a newer app), every raw page
    /// against its receipt, and sidecar timing. The folder
    /// is staged and renamed into place only then, so it exists only when complete. A replay of the same backup
    /// finds its folder and writes nothing.
    @concurrent
    public static func restore(_ backup: URL, into area: URL) async throws -> RestoreReport {
        let plan = try Importer.plan(backup)
        guard plan.manifest.kind == .backup else { throw ImportError.notABackup }
        let id = try ExportPackage.sha256(of: backup.appending(path: "manifest.json")).hex.prefix(16)
        var report = RestoreReport(
            location: area.appending(path: "backup-\(id)", directoryHint: .isDirectory), alreadyRestored: true,
            conversations: 0, pages: 0,
            unsupported: plan.unsupported
                + plan.manifest.items.map {
                    .init(item: $0.id, what: "conversation folder", reason: "A backup restores its stores only.")
                })
        let files = FileManager.default
        if files.fileExists(atPath: report.location.path) { return report }

        let staging = area.appending(path: ".staging-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? files.removeItem(at: staging) }
        for file in plan.manifest.files where file.path.hasPrefix("stores/") {
            try Task.checkCancellation()
            let target = staging.appending(path: String(file.path.dropFirst("stores/".count)))
            try files.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try files.copyItem(at: backup.appending(path: file.path), to: target)
        }
        let devices = Set(try read([SourceReference].self, backup, "sources.json").map(\.deviceId))
        (report.pages, report.conversations) = try await verify(staging, devices: devices)
        try files.moveItem(at: staging, to: report.location)
        report.alreadyRestored = false
        return report
    }

    /// Opens the staged stores as the app would and reads everything once. Returns (pages, conversations).
    private static func verify(_ root: URL, devices: Set<String>) async throws -> (Int, Int) {
        func fail(_ reason: String) -> ImportError { .invalid(item: "backup", reason: reason) }
        // Fails closed on an unknown schema; every page read is checked against its receipt's SHA-256.
        let source = try SourceStore(directory: root.appending(path: "source", directoryHint: .isDirectory))
        let derived = DerivedAudioDirectory(url: root.appending(path: "derived", directoryHint: .isDirectory))
        var pages = 0
        for device in devices {
            var next: UInt64 = 0
            while true {
                try Task.checkCancellation()
                let batch = try await source.pages(deviceID: device, from: next, limit: 256)
                guard let last = batch.last else { break }
                pages += batch.count
                next = last.key.index + 1
            }
            guard try derived.manifest(deviceID: device).segments.allSatisfy({ !$0.interval.isEmpty }) else {
                throw fail("an empty playback interval")
            }
            _ = try derived.decodeGaps(deviceID: device)
        }

        // Fails closed on a newer schema; every cached conversation decodes.
        let library = try LibraryStore(directory: root.appending(path: "library", directoryHint: .isDirectory))
        let conversations = try await library.conversations(before: nil, limit: .max).count
        return (pages, conversations)
    }
}
