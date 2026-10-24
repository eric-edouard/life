import Foundation
import PendantProtocol
import SourceStore
import Timeline

/// The stored pages of one device, reduced to what the timeline needs.
public struct PageScan: Sendable, Equatable {
    public var pages: [AudioPage]
    /// Pages that could not be read. They are left out of `pages`, so the timeline breaks there as missing pages.
    public var gaps: [DecodeGap]

    /// The highest store order read (`StoredPage.seq`), or `nil` when nothing was.
    public var seq: Int64?

    /// Reads `indices` in batches; memory holds one batch of payloads at a time.
    public static func scan(_ store: SourceStore, deviceID: String, indices: ClosedRange<UInt64>) async throws -> Self {
        var next = indices.lowerBound
        return try await scan {
            guard next <= indices.upperBound else { return [] }
            let batch = try await store.pages(deviceID: deviceID, from: next, limit: 256)
                .filter { $0.key.index <= indices.upperBound }
            if let last = batch.last { next = last.key.index + 1 }
            return batch
        }
    }

    /// Reads pages stored or rewritten after `seq`, in store order, in batches.
    public static func scan(_ store: SourceStore, deviceID: String, afterSeq seq: Int64) async throws -> Self {
        var next = seq
        return try await scan {
            let batch = try await store.pages(deviceID: deviceID, afterSeq: next, limit: 256)
            if let last = batch.last { next = last.seq }
            return batch
        }
    }

    private static func scan(batches next: () async throws -> [StoredPage]) async throws -> Self {
        var scan = PageScan(pages: [], gaps: [])
        while true {
            try Task.checkCancellation()
            let batch = try await next()
            guard !batch.isEmpty else { break }
            for page in batch {
                do {
                    scan.pages.append(try AudioPage(page))
                } catch {
                    scan.gaps.append(DecodeGap(page: page.key.index, packet: nil, reason: error))
                }
                scan.seq = max(scan.seq ?? page.seq, page.seq)
            }
        }
        return scan
    }
}

extension AudioPage {
    /// Reads a stored page by its source's kind (`DeviceKind.decodePage`): its clock, boot and where each Opus packet
    /// sits.
    init(_ stored: StoredPage) throws(DecodeGap.Reason) {
        let page = try decoded(stored.payload, deviceID: stored.key.deviceID)
        self.init(
            index: stored.key.index, session: stored.session, deviceMillis: stored.deviceTimeMillis, boot: page.boot,
            uptimeMillis: page.uptimeMillis.map { Int64($0) },
            runs: PacketRun.runs(offsets: page.packets.map(\.offsetMillis)),
            clockStepMillis: page.clockStepMillis)
    }
}

extension ClockModel {
    /// The device's clock syncs, each anchored by the first page it stamped when that page is stored, as far as pages
    /// from `page` on need: a page is timed from the latest anchor of its boot at or before it, so the anchors after
    /// `page` and the last one at or before it time them as all of them would. One page read per sync after `page`, not
    /// per sync ever (1,396 on the owner's phone by Oct 15; reading them all was most of a press's 16 s, and 30% of the
    /// derived audio's CPU).
    public static func load(_ store: SourceStore, deviceID: String, from page: UInt64) async throws -> ClockModel {
        let syncs = try await store.clockSyncs(deviceID: deviceID)
        var anchors: [ClockAnchor] = []
        for sync in syncs.reversed() {
            guard let stored = try await store.page(PageKey(deviceID: deviceID, index: sync.firstPageIndex)),
                let first = try? AudioPage(stored), let anchor = ClockAnchor(first)
            else { continue }
            anchors.append(anchor)
            if anchor.pageIndex <= page { break }
        }
        return ClockModel(syncs: syncs, anchors: anchors)
    }
}

extension ClockAnchor {
    /// The anchor a clock sync's first page gives, when it carries a plausible time and its uptime.
    public init?(_ page: AudioPage) {
        guard let uptime = page.uptimeMillis, page.deviceMillis > ClockModel.earliestPlausibleMillis else { return nil }
        self.init(pageIndex: page.index, boot: page.boot, uptimeMillis: uptime, deviceMillis: page.deviceMillis)
    }
}

private func decoded(_ payload: Data, deviceID: String) throws(DecodeGap.Reason) -> DecodedPage {
    guard let page = try? DeviceKind(deviceID: deviceID).decodePage(payload) else { throw .unreadablePage }
    guard !page.encrypted else { throw .encryptedPage }
    return page
}

/// Opus packets of one stored page of `deviceID`'s kind, in order. Pages without audio yield none.
func opusPackets(_ payload: Data, deviceID: String) throws(DecodeGap.Reason) -> [Data] {
    try decoded(payload, deviceID: deviceID).packets.map(\.data)
}

/// Decoded audio of the captured timeline of one device, read in bounded chunks straight from the source packs.
public struct SourceAudio: Sendable {
    /// Decoding starts this many packets early so the codec has converged (200 ms).
    static let prerollPackets = 10

    public let store: SourceStore
    public let deviceID: String
    public let spans: [CaptureSpan]

    public init(store: SourceStore, deviceID: String, spans: [CaptureSpan]) {
        self.store = store
        self.deviceID = deviceID
        self.spans = spans
    }

    public init(store: SourceStore, deviceID: String, pages: [AudioPage], clock: ClockModel) {
        self.init(store: store, deviceID: deviceID, spans: CaptureTimeline.spans(pages: pages, clock: clock))
    }

    /// Samples of `interval`, exactly `interval.millis × 16` of them. Each packet plays where the timeline put it;
    /// moments no packet covers are silence. Decode gaps are reported for packets starting inside `interval`.
    public func samples(_ interval: Range<CaptureInstant>) async throws -> (samples: [Float], gaps: [DecodeGap]) {
        let packetMillis = CaptureTimeline.packetMillis
        let from = interval.lowerBound.advanced(by: -Int64(Self.prerollPackets) * packetMillis)
        let runs = spans.filter { $0.interval.lowerBound < interval.upperBound && $0.interval.upperBound > from }
            .flatMap(\.runs).filter { $0.start < interval.upperBound && $0.end > from }
        var samples = [Float](repeating: 0, count: Int(interval.millis) * PendantAudio.samplesPerMilli)
        var gaps: [DecodeGap] = []
        var decoder: OpusPacketDecoder?
        var decodedUntil: CaptureInstant?
        var page: (index: UInt64, packets: [Data])?
        var packet: [Float] = []
        for run in runs {
            if page?.index != run.page {
                guard let stored = try await store.page(PageKey(deviceID: deviceID, index: run.page)),
                    let packets = try? opusPackets(stored.payload, deviceID: deviceID)
                else { throw AudioPipelineError.pageChanged(run.page) }
                page = (run.page, packets)
            }
            guard let packets = page?.packets, run.packets.upperBound <= packets.count else {
                throw AudioPipelineError.pageChanged(run.page)
            }
            for (step, position) in run.packets.enumerated() {
                let start = run.start.advanced(by: Int64(step) * packetMillis)
                guard start < interval.upperBound else { break }
                guard start.advanced(by: packetMillis) > from else { continue }
                // A new decoder after silence: the codec state belongs to the packets just before.
                if decodedUntil != start { decoder = try OpusPacketDecoder() }
                packet.removeAll(keepingCapacity: true)
                let outcome = decoder?.decode(packets[position], into: &packet)
                decodedUntil = start.advanced(by: packetMillis)
                let offset = Int(interval.lowerBound.distance(to: start)) * PendantAudio.samplesPerMilli
                let first = max(0, -offset)
                let last = min(packet.count, samples.count - offset)
                if first < last { samples[offset + first..<offset + last] = packet[first..<last] }
                guard start >= interval.lowerBound else { continue }
                switch outcome {
                case .rejected: gaps.append(DecodeGap(page: run.page, packet: position, reason: .rejectedPacket))
                case .unexpectedLength:
                    gaps.append(DecodeGap(page: run.page, packet: position, reason: .unexpectedLength))
                case .decoded, nil: break
                }
            }
        }
        return (samples, gaps)
    }
}
