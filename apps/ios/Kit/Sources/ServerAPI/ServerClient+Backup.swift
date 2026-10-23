import Foundation

/// The raw backup (contract "Other uploads"): sealed packs, a daily `source.sqlite` snapshot and the audio of
/// jobs transcribed before the bucket kept it. All stored, never processed.
extension ServerClient {
    /// What the server holds of a source's raw backup (openapi `BackupHeld`).
    public struct BackupHeld: Sendable, Decodable, Equatable {
        public struct File: Sendable, Decodable, Equatable {
            public var name: String
            public var sha256: String
            public var bytes: Int64
        }

        public struct Snapshot: Sendable, Decodable, Equatable {
            /// The UTC date, `yyyy-MM-dd`.
            public var date: String
            public var sha256: String
            public var bytes: Int64
        }

        public var packs: [File]
        public var latestSnapshot: Snapshot?
    }

    public func backup(source: String) async throws -> BackupHeld {
        try decode(BackupHeld.self, try await send(try request("backup/\(source)")))
    }

    /// A sealed pack, by its name without extension, sent from its file. Idempotent: one already held is not stored
    /// again.
    public func putPack(source: String, name: String, file: URL, sha256: String) async throws {
        try await sendRaw(try request("backup/packs/\(source)/\(name)", method: "PUT"), file: file, sha256: sha256)
    }

    /// A `VACUUM INTO` snapshot of `source.sqlite`; the server keeps one per UTC date.
    public func putSourceDB(source: String, file: URL, sha256: String) async throws {
        try await sendRaw(try request("backup/source-db/\(source)", method: "PUT"), file: file, sha256: sha256)
    }

    /// The prepared Ogg Opus of a completed job, rendered again; refused (409) unless it hashes to the job's.
    public func putJobAudio(job: UUID, file: URL) async throws {
        try await sendRaw(try request("jobs/\(lower(job))/audio", method: "PUT"), file: file, sha256: nil)
    }

    /// The body is read from `file` as it goes, never held in memory.
    private func sendRaw(_ request: URLRequest, file: URL, sha256: String?) async throws {
        var request = request
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        if let sha256 { request.setValue(sha256, forHTTPHeaderField: "X-Content-Sha256") }
        let (data, response) = try await session.upload(for: request, fromFile: file)
        _ = try Self.check(data, response)
    }
}
