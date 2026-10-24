import AudioPipeline
import CryptoKit
import Foundation
import Library
import ServerAPI
import SourceStore
import Timeline

/// The raw backup (docs/formats.md "Backup"): what the bucket needs so the archive survives losing the phone. The app
/// runs one round at a time in a lane of its own, beside the driver's runs, on Wi-Fi or power only: an item can take
/// minutes, and fragments never wait for it. Its network waits leave the actor free, so a run goes on meanwhile. In order:
/// today's `source.sqlite` snapshot, the audio of imported old-app jobs, the sealed packs, then the audio of the old
/// Pendant jobs, each oldest first, until done or the server can't take more.
///
/// ponytail: a pack's hash and the day's `VACUUM INTO` run on the actor (a fraction of a second, once a day), and in the
/// background the backup and fragments each rest as long as they rendered, so together they can near a core; move the
/// hashing off the actor, or share one rest, if a run's `upload` step or a CPU kill shows it.
///
/// It reads the source store's files and never writes them: no `SourceStore` call here writes, nothing feeds
/// `PageSink.ackableIndex`, and the open pack waits until the store rolls to the next. Raw packs hold dictation audio:
/// they go only to `PUT /backup/packs`, never into a fragment. Each item ends as a row of `backup` in `upload.sqlite`:
/// `sent`, `held` (the server had it, after a reinstall) or `skipped: <why>` (refused, or a job whose audio can't be
/// rendered as it was), never tried again. A pack that can't be read now is tried again next round; one whose size
/// changed since it was sent is sent again under its new hash.
extension Uploader {
    /// What the backup still has to send.
    public struct BackupStatus: Sendable, Equatable {
        public var packs: Int
        public var jobs: Int

        public init(packs: Int, jobs: Int) {
            self.packs = packs
            self.jobs = jobs
        }
    }

    public func backupStatus() async throws -> BackupStatus {
        BackupStatus(packs: try unsentPacks().count, jobs: try await oldJobs().count)
    }

    /// One round of the backup. Returns the items skipped in it, for the event log.
    @discardableResult
    public func backUp(library: LibraryStore) async throws -> [String] {
        let today = Date.now.formatted(.iso8601.year().month().day())
        var packs = try unsentPacks()
        var snapshot = !(try sent("snapshot").contains(today))
        if snapshot || !packs.isEmpty {
            let held = try await client.backup(source: deviceID)
            if let latest = held.latestSnapshot, latest.date == today {
                try record("snapshot", today, bytes: latest.bytes, sha256: latest.sha256, "held")
                snapshot = false
            }
            let server = Dictionary(held.packs.map { ($0.name, $0) }, uniquingKeysWith: { $1 })
            packs = try packs.filter { pack in
                guard let file = server[pack.name], file.bytes == pack.bytes else { return true }
                try record("pack", pack.name, bytes: file.bytes, sha256: file.sha256, "held")
                return false
            }
        }
        var skipped: [String] = []
        if snapshot {
            guard try await attempt("snapshot", today, &skipped, { try await sendSnapshot(today) }) else {
                return skipped
            }
        }
        var imported: [OldJob] = []
        var pendant: [OldJob] = []
        for var job in try await oldJobs() {
            if let audio = try await library.importedAudio(of: job.conversation.serverID) {
                job.imported = FileAudio(url: library.importedAudio.appending(path: audio.file), runs: audio.runs)
                imported.append(job)
            } else {
                pendant.append(job)
            }
        }
        for job in imported {
            guard canRunHeavyWork() else { return skipped }
            guard try await attempt("job", job.name, &skipped, { try await sendAudio(job) }) else { return skipped }
        }
        for pack in packs {
            guard try await attempt("pack", pack.name, &skipped, { try await sendPack(pack) }) else { return skipped }
        }
        for job in pendant {
            guard canRunHeavyWork() else { return skipped }
            guard try await attempt("job", job.name, &skipped, { try await sendAudio(job) }) else { return skipped }
        }
        return skipped
    }

    // MARK: Items

    /// A sealed pack: by the store's rule, any but the newest, which is still being appended to.
    struct SealedPack: Equatable {
        var url: URL
        var bytes: Int64
        var name: String { url.deletingPathExtension().lastPathComponent }
    }

    /// Sealed packs not sent at their current size, oldest first.
    func unsentPacks() throws -> [SealedPack] {
        let folder = source.directory.appending(path: "packs", directoryHint: .isDirectory)
        let ids = try FileManager.default.contentsOfDirectory(atPath: folder.path).compactMap { name in
            name.hasSuffix(".pack") ? Int64(name.dropLast(5)) : nil
        }.sorted().dropLast()
        // A skipped pack (bytes 0) stays skipped; a sent one goes again only if its size changed.
        let done = try db.query("SELECT name, bytes FROM backup WHERE kind = 'pack'") { ($0.text(0), $0.int(1)) }
        let sent = Dictionary(done, uniquingKeysWith: { $1 })
        return try ids.compactMap { id in
            let url = folder.appending(path: "\(id).pack")
            let bytes = Int64(try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
            return [0, bytes].contains(sent["\(id)"]) ? nil : SealedPack(url: url, bytes: bytes)
        }
    }

    private func sendPack(_ pack: SealedPack) async throws {
        // Mapped, not read, then sent from the file: 64 MB stays on disk.
        let (sha, bytes) = try await paced {
            let body = try Data(contentsOf: pack.url, options: .alwaysMapped)
            return (Self.hex(SHA256.hash(data: body)), Int64(body.count))
        }
        try await client.putPack(source: deviceID, name: pack.name, file: pack.url, sha256: sha)
        try record("pack", pack.name, bytes: bytes, sha256: sha, "sent")
    }

    /// `VACUUM INTO` from a connection of its own: a read of the receipts as they are, which capture keeps writing
    /// meanwhile (`Export.Backup` does the same).
    private func sendSnapshot(_ date: String) async throws {
        let file = prepared.appending(path: "source-\(date).sqlite")
        try? FileManager.default.removeItem(at: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let (sha, bytes) = try await paced {
            try SQLite(path: source.directory.appending(path: "source.sqlite").path, readOnly: true)
                .execute("VACUUM INTO '\(file.path.replacing("'", with: "''"))'")
            let body = try Data(contentsOf: file, options: .alwaysMapped)
            return (Self.hex(SHA256.hash(data: body)), Int64(body.count))
        }
        try await client.putSourceDB(source: deviceID, file: file, sha256: sha)
        try record("snapshot", date, bytes: bytes, sha256: sha, "sent")
    }

    /// An old completed part's job, with what its audio was rendered from.
    struct OldJob: Sendable {
        var id: UUID
        var sha256: String
        var map: TimeMap
        var conversation: ConversationID
        var imported: FileAudio?

        var name: String { id.uuidString.lowercased() }
    }

    /// The old ledger's completed parts whose audio isn't sent, oldest first, one per job. The parts are read once:
    /// nothing writes them any more.
    func oldJobs() async throws -> [OldJob] {
        if completedParts == nil {
            var seen = Set<UUID>()
            completedParts = try await scanner.oldParts().compactMap { part in
                guard part.state == "completed", let id = part.jobID, let sha = part.sha256, !sha.isEmpty,
                    let map = TimeMap(segments: part.segments), seen.insert(id).inserted
                else { return nil }
                return OldJob(id: id, sha256: sha, map: map, conversation: part.conversation)
            }
        }
        let done = Set(try sent("job"))
        return (completedParts ?? []).filter { !done.contains($0.name) }
    }

    /// Renders the job's audio as the old pipeline did (`PreparedAudio`, the part's time map, from the imported file
    /// or the packs), and sends it if it hashes to the job's.
    private func sendAudio(_ job: OldJob) async throws {
        let file = prepared.appending(path: "job-\(job.name).ogg")
        defer { try? FileManager.default.removeItem(at: file) }
        let rendered = try await paced {
            if let imported = job.imported { return try await PreparedAudio.render(job.map, from: imported, to: file) }
            let range = job.map.segments[0].lowerBound..<job.map.segments[job.map.segments.count - 1].upperBound
            let spans = try await scanner.timeline().spans(overlapping: range)
            let audio = SourceAudio(store: source, deviceID: deviceID, spans: spans)
            return try await PreparedAudio.render(job.map, from: audio, to: file)
        }
        guard rendered.sha256 == job.sha256 else { throw BackupError.audioChanged(rendered.sha256) }
        try await client.putJobAudio(job: job.id, file: file)
        try record("job", job.name, bytes: Int64(rendered.byteCount), sha256: rendered.sha256, "sent")
    }

    // MARK: Pacing and outcomes

    /// In the background, CPU work is followed by a rest as long as it took (as for fragments: iOS kills a background
    /// app that holds the CPU).
    private func paced<T>(_ work: () async throws -> T) async throws -> T {
        let start = ContinuousClock.now
        let result = try await work()
        if inBackground() { try await rest(start.duration(to: .now)) }
        return result
    }

    /// Runs one item. Returns `false` to stop the round: the server is down or busy, or the token refused (all but
    /// `ServerClient.refuses`), it goes next round.
    /// No connection throws. A refusal, or a job that can't be rendered as it was, is skipped for good; a pack that
    /// can't be read (a passing file error) is left for the next round.
    private func attempt(
        _ kind: String, _ name: String, _ skipped: inout [String], _ send: () async throws -> Void
    ) async throws -> Bool {
        do {
            try await send()
        } catch let error as ServerClient.ClientError {
            guard case .server(let status, _, _) = error, ServerClient.refuses(status) else {
                return false
            }
            try skip(kind, name, error, &skipped)
        } catch let error as URLError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch  where kind == "pack" {
            skipped.append("\(kind) \(name): \(error)")
        } catch {
            try skip(kind, name, error, &skipped)
        }
        return true
    }

    private func skip(_ kind: String, _ name: String, _ error: any Error, _ skipped: inout [String]) throws {
        try record(kind, name, bytes: 0, sha256: nil, "skipped: \(error)")
        skipped.append("\(kind) \(name): \(error)")
    }

    private func record(_ kind: String, _ name: String, bytes: Int64, sha256: String?, _ outcome: String) throws {
        try db.run(
            "INSERT OR REPLACE INTO backup VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            [
                .text(kind), .text(name), .int(bytes), sha256.map { .text($0) } ?? .null, .text(outcome),
                .int(Int64(Date.now.timeIntervalSince1970 * 1000)),
            ])
    }

    /// Names of the items of `kind` done for good.
    func sent(_ kind: String) throws -> [String] {
        try db.query("SELECT name FROM backup WHERE kind = ?1", [.text(kind)]) { $0.text(0) }
    }

    private static func hex(_ digest: SHA256.Digest) -> String {
        digest.map { String(format: "%02x", $0) }.joined()
    }
}

enum BackupError: Error, CustomStringConvertible {
    /// The audio rendered again no longer hashes to the job's: the clock model or the source moved since.
    case audioChanged(String)

    var description: String {
        switch self {
        case .audioChanged(let sha): "audio_hash_mismatch: rendered \(sha)"
        }
    }
}
