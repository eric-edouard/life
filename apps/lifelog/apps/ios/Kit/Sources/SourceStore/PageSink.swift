import Foundation
import Timeline

/// Identity of one stored page: `deviceID` is the store's slot for the Pendant and `index` is
/// `FlashLife.base + the Pendant's page index`. The Pendant's index is device-global and monotonic within one
/// flash life, and `DeleteFlashPage(i)` frees every page at or below `i` on that device, whatever its session.
public struct PageKey: Hashable, Sendable, Codable {
    public var deviceID: String
    public var index: UInt64

    public init(deviceID: String, index: UInt64) {
        self.deviceID = deviceID
        self.index = index
    }
}

/// One life of a Pendant's flash: from first use until its page indices could have restarted (storage cleared,
/// factory reset, another Pendant). Each life owns a band of 2^40 store indices, so receipts from one life can
/// never vouch for another life's pages. Life 0 holds receipts written before lives existed and is never reused.
public struct FlashLife: Sendable, Equatable {
    public var number: Int64

    public init(number: Int64) { self.number = number }

    public var base: UInt64 { UInt64(number) << 40 }
}

/// One raw page exactly as received (the `StorageBufferMsg` bytes), before any decoding.
public struct RawPage: Sendable {
    public var key: PageKey
    /// Storage session from the page envelope. Metadata only; it plays no part in ACK math.
    public var session: Int64
    /// `FlashPage.absolute_timestamp_ms` from the Pendant RTC, kept raw. Never substitute the receive time.
    public var deviceTimeMillis: Int64
    public var payload: Data
    public var receivedAt: Date

    public init(key: PageKey, session: Int64, deviceTimeMillis: Int64, payload: Data, receivedAt: Date) {
        self.key = key
        self.session = session
        self.deviceTimeMillis = deviceTimeMillis
        self.payload = payload
        self.receivedAt = receivedAt
    }
}

public enum PersistOutcome: Sendable, Equatable {
    /// Written now: a new page, or a replay that replaced stored bytes that no longer matched their receipt.
    case stored
    /// Same key, device time and SHA-256 as a stored page whose bytes still verify. Nothing was written.
    case duplicate
    /// Same key and device time, different bytes. The stored page is kept, the new bytes are recorded as incident
    /// evidence, and ACK stops below this index until the owner picks a copy.
    case conflict
    /// Same key, another device time: the Pendant restarted its indices. Kept as incident evidence like a conflict;
    /// capture then starts a new flash life instead of matching this life's receipts.
    case indexReused
}

/// Why a page could not be kept. A gap is recorded with its evidence before sync may move past it.
public enum GapReason: Sendable, Equatable, Codable {
    case deviceReadFailed
    case deviceCorrupt
    /// A page we couldn't decode, which the owner chose to let go from the Pendant (`HeldReason.undecodable`).
    case undecodable(detail: String)
    /// Encrypted audio the owner chose to let go from the Pendant. The encrypted bytes are the evidence.
    case encrypted

    /// Plain words for the incident that records it.
    var detail: String {
        switch self {
        case .deviceReadFailed: "the Pendant couldn't read it"
        case .deviceCorrupt: "the Pendant reported it corrupt"
        case .undecodable(let detail): "it arrived unreadable: \(detail)"
        case .encrypted: "encrypted"
        }
    }
}

/// Why a page that arrived is kept on the Pendant instead of stored: it holds the ACK until the owner accepts it as a
/// gap.
public enum HeldReason: Sendable, Equatable {
    /// Audio another host encrypted, which we can't decrypt.
    case encrypted
    /// A page this app can't decode, or one without a timestamp: a decoder bug or a new firmware format. A later app
    /// may read it, so it stays on the Pendant.
    case undecodable(detail: String)

    /// The gap it becomes once the owner accepts it.
    public var gap: GapReason {
        switch self {
        case .encrypted: .encrypted
        case .undecodable(let detail): .undecodable(detail: detail)
        }
    }
}

/// The contract between capture (stream A) and the source store (stream B).
///
/// The only thing that may authorize an ACK — which deletes flash pages on the Pendant — is
/// `ackableIndex`, and it only ever covers a contiguous run of pages that are durably stored
/// (fsync'd pack bytes plus a committed receipt) or explicitly recorded as gaps.
public protocol PageSink: Sendable {
    /// The flash life to store under. `evidence` is the Pendant's identity and generation (`DeviceInfo`); evidence
    /// that differs from the current life's starts a new one. `nil` (the Pendant didn't say) keeps the current life.
    func flashLife(deviceID: String, evidence: String?) async throws -> FlashLife
    /// Starts a new life with the current evidence, after the Pendant re-used an index (`indexReused`).
    func startNewFlashLife(deviceID: String, reason: String) async throws -> FlashLife
    /// Returns only after the page is durable. Idempotent: a replayed page returns `.duplicate`.
    func persist(_ page: RawPage) async throws -> PersistOutcome
    /// Durably records that a page is missing or unreadable, with the device's evidence (the raw envelope). Returns
    /// `false`, recording nothing, when the page is already stored: its saved copy stands.
    @discardableResult
    func recordGap(_ key: PageKey, reason: GapReason, evidence: Data) async throws -> Bool
    /// Keeps a page we can't store as an incident that blocks ACK, with its raw envelope as evidence. Returns `true`
    /// once the owner has accepted exactly these bytes as a gap, so the drain may settle it.
    func recordHeld(_ key: PageKey, reason: HeldReason, evidence: Data) async throws -> Bool
    /// End of the contiguous run of durable-or-gapped indices that starts at `oldest`, the device's oldest
    /// unacked index. `nil` when `oldest` itself is not durable. Stops below any unresolved incident (a replay
    /// conflict, or stored bytes that no longer match their receipt).
    ///
    /// Stored receipts outlive the device's flash, so after an index restart old receipts could cover new,
    /// unsaved pages. Capture must also cap the ACK at the unbroken run from `oldest` that the same drain got
    /// back as `.stored`, `.duplicate` or a recorded gap.
    func ackableIndex(deviceID: String, startingAt oldest: UInt64) async throws -> UInt64?
    /// End of the contiguous run of indices from `oldest` the phone has: stored, recorded as gaps, or held (kept as an
    /// incident's evidence until the owner lets it go). What the backlog counts as saved, so a held page doesn't hold
    /// back what the phone reports it heard. Never authorizes an ACK.
    func savedIndex(deviceID: String, startingAt oldest: UInt64) async throws -> UInt64?
    /// The highest index `life` holds, stored or gapped; `nil` when it holds none. Never authorizes an ACK.
    func newestIndex(deviceID: String, in life: FlashLife) async throws -> UInt64?
    /// Durably records a `SetCurrentTime`, so capture time can be corrected for drift (`ClockModel`).
    func recordClockSync(_ sync: ClockSync, deviceID: String) async throws
    /// Durably records a pause or resume the Pendant confirmed, so segmentation can split there. Idempotent.
    func recordRecordingChange(_ change: RecordingChange, deviceID: String) async throws
}
