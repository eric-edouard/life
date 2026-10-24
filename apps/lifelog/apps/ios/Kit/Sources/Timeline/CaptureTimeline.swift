/// One stored page, reduced to what the timeline needs.
public struct AudioPage: Sendable, Equatable, Codable {
    public var index: UInt64
    public var session: Int64
    /// `FlashPage.absolute_timestamp_ms`, raw from the Pendant RTC: when the page was opened.
    public var deviceMillis: Int64
    /// `StorageBufferMsg.run`: which boot of the Pendant wrote the page.
    public var boot: UInt64
    /// `FlashPage.boot_uptime_ms` when the page was opened; `nil` when absent.
    public var uptimeMillis: Int64?
    /// The page's Opus packets in page order; empty for pages without audio (status, buttons, lifecycle markers).
    public var runs: [PacketRun]
    /// How coarse `deviceMillis` is: an Omi record carries a whole second. `nil`: to the millisecond.
    public var clockStepMillis: Int64?

    public init(
        index: UInt64, session: Int64, deviceMillis: Int64, boot: UInt64 = 0, uptimeMillis: Int64? = nil,
        runs: [PacketRun], clockStepMillis: Int64? = nil
    ) {
        self.index = index
        self.session = session
        self.deviceMillis = deviceMillis
        self.boot = boot
        self.uptimeMillis = uptimeMillis
        self.runs = runs
        self.clockStepMillis = clockStepMillis
    }

    /// A page whose `packetCount` packets start at its timestamp, back to back.
    public init(index: UInt64, session: Int64, deviceMillis: Int64, packetCount: Int) {
        self.init(
            index: index, session: session, deviceMillis: deviceMillis,
            runs: packetCount > 0 ? [PacketRun(offsetMillis: 0, count: packetCount)] : [])
    }

    public var packetCount: Int { runs.reduce(0) { $0 + $1.count } }
}

/// Packets of one page the Pendant wrote back to back, 20 ms each.
public struct PacketRun: Sendable, Equatable, Codable {
    /// When the first packet starts, in milliseconds after the page timestamp (`Chunk.time_offset_ms`).
    public var offsetMillis: Int64
    public var count: Int

    public init(offsetMillis: Int64, count: Int) {
        self.offsetMillis = offsetMillis
        self.count = count
    }

    /// Groups packets by their offsets (one per packet, in page order). A packet more than the continuity tolerance
    /// away from where the previous one ended starts a new run; the time between is silence.
    public static func runs(offsets: [Int64]) -> [PacketRun] {
        var runs: [PacketRun] = []
        for offset in offsets {
            if let last = runs.last,
                abs(offset - last.offsetMillis - Int64(last.count) * CaptureTimeline.packetMillis)
                    <= CaptureTimeline.continuityToleranceMillis
            {
                runs[runs.count - 1].count += 1
            } else {
                runs.append(PacketRun(offsetMillis: offset, count: 1))
            }
        }
        return runs
    }
}

/// Where one `PacketRun` plays.
public struct PlacedRun: Sendable, Equatable, Codable {
    public var page: UInt64
    /// Positions of its packets among all packets of the page.
    public var packets: Range<Int>
    public var start: CaptureInstant

    public init(page: UInt64, packets: Range<Int>, start: CaptureInstant) {
        self.page = page
        self.packets = packets
        self.start = start
    }

    public var end: CaptureInstant { start.advanced(by: Int64(packets.count) * CaptureTimeline.packetMillis) }
}

/// Why a span does not continue the previous one.
public enum BreakReason: String, Sendable, Hashable, Codable {
    /// Nothing was recorded for longer than `CaptureTimeline.silenceFillMillis`.
    case timeGap
    /// The audio's clock says it started before audio already placed (a clock stepped back with no anchor to fix
    /// it). It is placed right after that audio instead: never played twice, never dropped.
    case overlap
    /// Page indices are missing and not all recorded as gaps (pages not received yet). What was there is unknown.
    case missingPages
    /// Every missing index is a recorded gap: the device reported the pages unreadable. A known loss, not possible
    /// speech still on its way.
    case recordedGap
    /// An audio page with no trustworthy time. Its audio cannot be placed; it stays in the source store.
    case untimedPage
}

/// A run of continuous capture: audio packets where `runs` put them, silence between them.
public struct CaptureSpan: Sendable, Equatable, Codable {
    public var interval: Range<CaptureInstant>
    public var pages: ClosedRange<UInt64>
    /// Empty for the first span.
    public var breaks: Set<BreakReason>
    /// In time order, back to back or with short silences between.
    public var runs: [PlacedRun]

    public init(
        interval: Range<CaptureInstant>, pages: ClosedRange<UInt64>, breaks: Set<BreakReason>, runs: [PlacedRun] = []
    ) {
        self.interval = interval
        self.pages = pages
        self.breaks = breaks
        self.runs = runs
    }
}

public enum CaptureTimeline {
    public static let packetMillis: Int64 = 20
    /// Packets this close to where the previous audio ended continue it, back to back. The Pendant writes them with
    /// a few milliseconds of jitter (±4 ms on the owner's unit, with no drift over minutes).
    public static let continuityToleranceMillis: Int64 = 60
    /// A shorter stretch without packets inside a recording is silence within the span, so a quiet stretch (Opus DTX
    /// sends a packet at least every 400 ms) stays one file. A longer one ends the span: nothing was recorded there.
    public static let silenceFillMillis: Int64 = 1_000

    /// Builds continuous spans from pages, in page-index order. Every packet run plays at its page's capture time
    /// plus its chunk offset (`ClockModel.captureInstant(of:)`).
    ///
    /// Page indices only grow, so audio is never placed before audio of a lower index: a run whose clock says
    /// otherwise starts right where that audio ends (`overlap`). Each packet plays exactly once and none is dropped.
    /// A coarse clock (`AudioPage.clockStepMillis`) widens what counts as continuing: an Omi's records, about 100 ms
    /// each, carry whole seconds, so a run's frames play 20 ms apart from its first stamp and a stamp that jumps
    /// further than its step starts again where the stamp says.
    /// `knownGaps` are indices recorded as lost (`SourceStore.gaps`, unreadable pages).
    ///
    /// `after` continues a timeline already built: the span the pages follow, so only pages after its last one are
    /// read. It must end where a break did (the next span started anew), and is not returned.
    public static func spans(
        pages: [AudioPage], clock: ClockModel, knownGaps: Set<UInt64> = [], after seed: CaptureSpan? = nil
    ) -> [CaptureSpan] {
        var spans = seed.map { [$0] } ?? []
        var pending: Set<BreakReason> = []
        var previous = seed?.pages.upperBound
        for page in pages.sorted(by: { $0.index < $1.index }) {
            if let previous, previous + 1 < page.index {
                let missing = previous + 1..<page.index
                let known = missing.count <= knownGaps.count && missing.allSatisfy(knownGaps.contains)
                pending.insert(known ? .recordedGap : .missingPages)
            }
            previous = page.index
            guard !page.runs.isEmpty else { continue }
            guard let opened = clock.captureInstant(of: page) else {
                pending.insert(.untimedPage)
                continue
            }
            var first = 0
            let step = page.clockStepMillis ?? 0
            for run in page.runs {
                defer { first += run.count }
                var start = opened.advanced(by: run.offsetMillis)
                if let end = spans.last?.interval.upperBound {
                    let jump = end.distance(to: start)
                    if jump > silenceFillMillis + step { pending.insert(.timeGap) }
                    if jump < -(continuityToleranceMillis + step) { pending.insert(.overlap) }
                    // Jitter and overlaps start back to back; a short silence stays where the clock put it.
                    if jump <= continuityToleranceMillis + step { start = end }
                }
                let placed = PlacedRun(page: page.index, packets: first..<first + run.count, start: start)
                if let last = spans.indices.last, pending.isEmpty {
                    spans[last].interval = spans[last].interval.lowerBound..<placed.end
                    spans[last].pages = spans[last].pages.lowerBound...page.index
                    spans[last].runs.append(placed)
                } else {
                    spans.append(
                        CaptureSpan(
                            interval: start..<placed.end, pages: page.index...page.index,
                            breaks: spans.isEmpty ? [] : pending, runs: [placed]))
                    pending = []
                }
            }
        }
        guard let seed else { return spans }
        assert(spans.first == seed, "a seed span must end at a break")
        return Array(spans.dropFirst())
    }
}
