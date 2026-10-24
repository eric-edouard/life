import Foundation

/// Derived work (decode, segment, encode) for a contiguous range of newly stored pages of one device.
public struct DerivedJob: Sendable, Equatable {
    public var id: Int64
    public var deviceID: String
    public var indices: ClosedRange<UInt64>
    /// Attempts including the current one.
    public var attempts: Int
}

/// A retryable queue in the same database as the receipts. Jobs are enqueued in the receipt's transaction, so
/// a stored page always has its job, but nothing here is ever consulted by `persist` or `ackableIndex`.
extension SourceStore {
    static let maxJobAttempts = 8

    /// Extends the pending job that ends just before this page, or starts a new one.
    func enqueueJob(_ key: [SQLValue]) throws {
        let extended = try db.run(
            """
            UPDATE jobs SET last_index = ?2
            WHERE device_id = ?1 AND last_index = ?2 - 1 AND state = 'pending' AND attempts = 0
            """,
            key
        )
        guard extended == 0 else { return }
        try db.run(
            "INSERT INTO jobs (device_id, first_index, last_index, state, not_before) VALUES (?1, ?2, ?2, 'pending', 0)",
            key
        )
    }

    /// Queues `indices` again, for playback audio that must be rebuilt (a restored backup keeps sidecars, not audio).
    /// A job already queued for exactly these pages is not queued twice.
    public func requeueJob(deviceID: String, indices: ClosedRange<UInt64>) throws {
        guard let first = Int64(exactly: indices.lowerBound), let last = Int64(exactly: indices.upperBound) else {
            throw SourceStoreError.indexOutOfRange(indices.upperBound)
        }
        try db.run(
            """
            INSERT INTO jobs (device_id, first_index, last_index, state, not_before)
            SELECT ?1, ?2, ?3, 'pending', 0
            WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE device_id = ?1 AND first_index = ?2 AND last_index = ?3)
            """,
            [.text(deviceID), .int(first), .int(last)]
        )
    }

    /// The pages of the device's jobs not done yet (pending or running): audio the analyzers haven't covered.
    public func queuedJobs(deviceID: String) throws -> [ClosedRange<UInt64>] {
        try db.query(
            "SELECT first_index, last_index FROM jobs WHERE device_id = ?1 AND state IN ('pending', 'running')",
            [.text(deviceID)]
        ) { UInt64($0.int(0))...UInt64($0.int(1)) }
    }

    /// Claims the oldest due job. A job left running by a crash is pending again after the next open.
    public func claimJob(now: Date = .now) throws -> DerivedJob? {
        try db.query(
            """
            UPDATE jobs SET state = 'running', attempts = attempts + 1
            WHERE id = (SELECT id FROM jobs WHERE state = 'pending' AND not_before <= ?1 ORDER BY id LIMIT 1)
            RETURNING id, device_id, first_index, last_index, attempts
            """,
            [.real(now.timeIntervalSince1970)]
        ) {
            DerivedJob(
                id: $0.int(0), deviceID: $0.text(1), indices: UInt64($0.int(2))...UInt64($0.int(3)),
                attempts: Int($0.int(4)))
        }.first
    }

    public func completeJob(_ id: Int64) throws {
        try db.run("DELETE FROM jobs WHERE id = ?1", [.int(id)])
    }

    /// Puts a job interrupted by cancellation back without counting the attempt.
    public func releaseJob(_ id: Int64) throws {
        try db.run(
            "UPDATE jobs SET state = 'pending', attempts = attempts - 1 WHERE id = ?1 AND state = 'running'", [.int(id)]
        )
    }

    /// Retries with exponential backoff (30 s doubling, capped at 6 h) until `maxJobAttempts`, then `failed`,
    /// where it stays visible without ever affecting capture or ACK.
    public func failJob(_ id: Int64, error: String, now: Date = .now) throws {
        try db.run(
            """
            UPDATE jobs SET
                state = CASE WHEN attempts >= ?3 THEN 'failed' ELSE 'pending' END,
                not_before = ?2 + MIN(30 << attempts, 21600),
                last_error = ?4
            WHERE id = ?1 AND state = 'running'
            """,
            [.int(id), .real(now.timeIntervalSince1970), .int(Int64(Self.maxJobAttempts)), .text(error)]
        )
    }
}
