import AudioPipeline
import Foundation
import Library
import SourceStore
import Timeline

/// The timeline `TimelineScanner` keeps, handed to the uploader as a value: where analysis stops, and reads of the
/// audio spans, analyzer labels and kept audio of any stretch. A read goes to the scanner's tables and the sidecars it
/// covers, so a run pays only for the stretches it looks at.
public struct TimelineSnapshot: Sendable {
    /// Where stored audio the analyzers haven't reached starts; `nil` when they reached all of it.
    public var unanalyzedFrom: CaptureInstant?
    /// Timeline facts from here on changed since they were last sent (`TimelineScanner.factsSent`); `nil`: none did.
    public var factsFrom: CaptureInstant?
    /// The lowest page stored since the uploader last looked (`TimelineScanner.storedSeen`); `nil`: none was.
    public var storedFrom: UInt64?
    /// Where the analyzers reached; audio after it isn't read yet.
    let frontier: CaptureInstant?
    let scanner: TimelineScanner

    /// Stored audio the analyzers reached that overlaps `range`, in capture time: the first `limit` spans.
    public func spans(overlapping range: Range<CaptureInstant>, limit: Int = .max) async throws -> [CaptureSpan] {
        try await scanner.spans(overlapping: range, frontier: frontier, limit: limit)
    }

    /// Where the last stored audio ending at or before `instant` ends.
    public func audioEnd(atOrBefore instant: CaptureInstant) async throws -> CaptureInstant? {
        try await scanner.audioEnd(atOrBefore: instant)
    }

    /// When the first packet of page `page` or a later one plays; `nil` while none is stored.
    public func start(ofPage page: UInt64) async throws -> CaptureInstant? {
        try await scanner.start(ofPage: page)
    }

    /// The analyzers' labels overlapping any of `ranges`.
    public func windows(overlapping ranges: [Range<CaptureInstant>]) async throws -> [ActivityWindow] {
        try await scanner.windows(overlapping: ranges)
    }

    /// The audio in `range` uploads may carry (`SpeechPolicy.keptAudio`), quiet ranges left out.
    public func kept(in range: Range<CaptureInstant>) async throws -> [Range<CaptureInstant>] {
        try await scanner.kept(in: range, frontier: frontier)
    }
}

/// Reads the Pendant's pages, gaps, clock, analyzer labels and pauses into a timeline the uploader sends from
/// (`FactsBuilder`, `SpeechFragment`). It owns the scanned-pages cache in `timeline.sqlite` (`pages`, `scans`) and what
/// it builds from it (`spans`, `clock`, the `sidecars` index, which the worker hands each sidecar to: `index`). A page
/// stored late, a new gap or clock anchor rebuild the spans from where they change, and move the timeline facts owed
/// back to there (`factsFrom`).
public actor TimelineScanner {
    public nonisolated let deviceID: String
    /// The kept-audio rule uploads follow (`SpeechPolicy.keptAudio`), the one fragments pad by.
    public nonisolated let policy: SpeechPolicy
    private let source: SourceStore
    private let derived: DerivedAudioDirectory
    private let library: LibraryStore
    private let store: TimelineStore

    /// - Parameter database: its `timeline.sqlite`.
    public init(
        source: SourceStore, derived: DerivedAudioDirectory, library: LibraryStore, database: URL,
        deviceID: String, policy: SpeechPolicy = SpeechPolicy()
    ) throws {
        self.source = source
        self.derived = derived
        self.library = library
        self.deviceID = deviceID
        self.policy = policy
        store = try TimelineStore(file: database, derived: derived, deviceID: deviceID)
    }

    /// The timeline as the last scan left it, at no cost: nothing is read until asked.
    public func timeline() async throws -> TimelineSnapshot {
        try await snapshot()
    }

    /// Reads new pages, gaps, clock syncs and pauses into the timeline, and moves `factsFrom` back to where they
    /// changed. Labels came in already (`index`).
    @discardableResult
    public func scan() async throws -> TimelineSnapshot {
        try await scanNewPages()
        try await rebuildSpans()
        try await readPauses()
        return try await snapshot()
    }

    /// The old pipeline's upload parts, read-only, for the backup of old jobs' audio.
    public func oldParts() throws -> [PartRecord] {
        try store.parts()
    }

    /// The facts from `from` on were sent through `through` (`nil`: all of them). Kept owed when something earlier
    /// changed since the snapshot that read them.
    public func factsSent(from: CaptureInstant, through: CaptureInstant?) throws {
        var state = try store.scanState(deviceID: deviceID)
        guard state.facts == from else { return }
        state.facts = through
        try store.setScanState(state, deviceID: deviceID)
    }

    /// The uploader saw the pages stored from `page` on: its cursor is at or below it. Kept when a lower one came since
    /// the snapshot that read it.
    public func storedSeen(from page: UInt64) throws {
        var state = try store.scanState(deviceID: deviceID)
        guard state.stored == page else { return }
        state.stored = nil
        try store.setScanState(state, deviceID: deviceID)
    }

    /// Owes the timeline facts from `instant` on, and nothing before (`nil`: none): the uploader starts its timeline
    /// there.
    public func startFacts(from instant: CaptureInstant?) throws {
        var state = try store.scanState(deviceID: deviceID)
        state.facts = instant
        try store.setScanState(state, deviceID: deviceID)
    }

    /// Only pauses split. A resume is stamped when the Pendant confirms it, a second or two after recording started,
    /// so it would cut the first words off as their own conversation.
    public static func pauses(_ changes: [RecordingChange]) -> [CaptureInstant] {
        changes.filter { $0.kind == .paused }.map(\.at)
    }

    /// Indexes a sidecar the worker wrote or found finished (`DerivedAudioWorker.run`), and pulls the facts owed back
    /// to where it changes them (`TimelineStore.index`).
    func index(_ segment: PlaybackSegment) throws {
        guard segment.deviceID == deviceID else { return }
        try store.index(
            [(derived.sidecarURL(deviceID, pages: segment.pages).lastPathComponent, segment)], deviceID: deviceID)
    }

    // MARK: Reads

    func spans(overlapping range: Range<CaptureInstant>, frontier: CaptureInstant?, limit: Int = .max) throws
        -> [CaptureSpan]
    {
        guard let frontier else { return [] }
        return try store.spans(deviceID: deviceID, overlapping: range, limit: limit).compactMap { span in
            guard span.interval.lowerBound < frontier else { return nil }
            var span = span
            span.interval = span.interval.lowerBound..<min(span.interval.upperBound, frontier)
            return span.interval.overlaps(range) ? span : nil
        }
    }

    func audioEnd(atOrBefore instant: CaptureInstant) throws -> CaptureInstant? {
        try store.spanEnd(deviceID: deviceID, atOrBefore: instant)
    }

    func start(ofPage page: UInt64) throws -> CaptureInstant? {
        let candidates =
            try store.spans(deviceID: deviceID, startingBelow: page + 1).prefix(1)
            + store.spans(deviceID: deviceID, startingAbove: page)
        return candidates.lazy.flatMap(\.runs).first { $0.page >= page }?.start
    }

    func windows(overlapping ranges: [Range<CaptureInstant>]) throws -> [ActivityWindow] {
        var names: [String] = []
        var seen: Set<String> = []
        for range in ranges {
            for name in try store.sidecars(deviceID: deviceID, overlapping: range) where seen.insert(name).inserted {
                names.append(name)
            }
        }
        return try names.flatMap { try derived.segment(deviceID: deviceID, named: $0).activity }.filter { window in
            ranges.contains { $0.overlaps(window.interval) }
        }
    }

    /// `SpeechPolicy.keptAudio` of `range` alone. Speech is padded and short cuts are bridged, so it reads a margin
    /// around `range` wide enough that nothing outside can change what is kept inside.
    func kept(in range: Range<CaptureInstant>, frontier: CaptureInstant?) async throws -> [Range<CaptureInstant>] {
        let margin = policy.minimumCutMillis + 2 * policy.paddingMillis
        let wide = range.lowerBound.advanced(by: -margin)..<range.upperBound.advanced(by: margin)
        let spans = try spans(overlapping: wide, frontier: frontier).map { span in
            var span = span
            span.interval = span.interval.clamped(to: wide)
            return span
        }
        let windows = try windows(overlapping: [
            wide.lowerBound.advanced(by: -policy.paddingMillis)..<wide.upperBound.advanced(by: policy.paddingMillis)
        ])
        let quiet = try await library.quietRanges(in: range)
        return policy.keptAudio(spans: spans, windows: windows, quietRanges: quiet).map { $0.clamped(to: range) }
            .filter { !$0.isEmpty }
    }

    private func snapshot() async throws -> TimelineSnapshot {
        let frontier = try store.frontier(deviceID: deviceID)
        // Audio the analyzers haven't reached would count as possible speech and swallow every pause after it.
        let unanalyzed = try store.firstSpan(deviceID: deviceID, endingAfter: frontier).map {
            max($0.lowerBound, frontier ?? $0.lowerBound)
        }
        let state = try store.scanState(deviceID: deviceID)
        return TimelineSnapshot(
            unanalyzedFrom: unanalyzed, factsFrom: state.facts, storedFrom: state.stored, frontier: frontier,
            scanner: self)
    }

    // MARK: Pass

    /// Reads metadata of pages stored or rewritten since the last scan, in store order, so a page stored below a
    /// higher index is read too. Payloads are read in batches and dropped.
    private func scanNewPages() async throws {
        let scan = try await PageScan.scan(
            source, deviceID: deviceID, afterSeq: try store.lastScannedSeq(deviceID: deviceID) ?? 0)
        try store.save(scan, deviceID: deviceID)
    }

    /// Rebuilds the spans from the first page whose span can have changed: a page scanned, a gap recorded, a clock
    /// sync or anchor. Spans before it are kept, and the one just before seeds the rest, so they come out as a build
    /// from the first page would. The facts owed move back to where the kept spans end.
    private func rebuildSpans() async throws {
        var state = try store.scanState(deviceID: deviceID)
        let gaps = Set(try await source.gaps(deviceID: deviceID).keys)
        var dirty = ([state.dirtyPage] + [gaps.subtracting(state.gaps).min()]).compactMap(\.self).min()
        let clock = try await readClock(rescanFrom: state.dirtyPage)
        if let moved = clock.moved { dirty = min(dirty ?? moved, moved) }
        guard let dirty else { return }
        let below = try store.spans(deviceID: deviceID, startingBelow: dirty)
        let seed = below.count == 2 ? below[1] : nil
        let from = seed.map { $0.pages.upperBound + 1 } ?? 0
        let cached = try store.pages(deviceID: deviceID, from: from)
        let spans = CaptureTimeline.spans(
            pages: cached.pages, clock: clock.model, knownGaps: gaps.union(cached.unreadable), after: seed)
        state.gaps = gaps.sorted()
        state.dirtyPage = nil
        state.pull(seed?.interval.upperBound ?? CaptureInstant(millis: .min))
        try store.replaceSpans(from: from, with: spans, clock: clock.changed, state: state, deviceID: deviceID)
    }

    /// The clock: the syncs, each with its anchor (the first page it stamped, read once from the scanned pages); the
    /// entries that changed since the spans were built; and the lowest page whose time those changes can move.
    /// ponytail: every sync is read each pass (a few hundred a day); read only the latest ones if that shows up.
    private func readClock(rescanFrom rescanned: UInt64?) async throws -> (
        model: ClockModel, changed: [UInt64: ClockEntry?], moved: UInt64?
    ) {
        let old = try store.clock(deviceID: deviceID)
        var entries = Dictionary(uniqueKeysWithValues: old.map { ($0.sync.firstPageIndex, $0) })
        let syncs = try await source.clockSyncs(deviceID: deviceID)
        var changed: [UInt64: ClockEntry?] = [:]
        var moves: [UInt64] = []
        for sync in syncs where entries[sync.firstPageIndex]?.sync != sync {
            entries[sync.firstPageIndex] = ClockEntry(sync: sync)
            changed[sync.firstPageIndex] = ClockEntry(sync: sync)
            moves.append(sync.firstPageIndex)
        }
        for gone in Set(entries.keys).subtracting(syncs.map(\.firstPageIndex)) {
            entries[gone] = nil
            changed[gone] = .some(nil)
            moves.append(gone)
        }
        // A page scanned again (rewritten in the store) is read again.
        for (first, entry) in entries where !entry.checked || first >= rescanned ?? .max {
            guard let page = try store.page(deviceID: deviceID, index: first) else { continue }
            let checked = ClockEntry(sync: entry.sync, anchor: page.flatMap(ClockAnchor.init), checked: true)
            if checked.anchor != entry.anchor { moves.append(first) }
            if checked != entry { changed[first] = checked }
            entries[first] = checked
        }
        let model = ClockModel(syncs: entries.values.map(\.sync), anchors: entries.values.compactMap(\.anchor))
        guard let lowest = moves.min() else { return (model, changed, nil) }
        // A sync corrects the epoch before it; an anchor times its boot's pages back to the anchor before it. So the
        // pages from the anchor before the sync before the change on can move. Boots follow each other in page order.
        let syncPages = Set(old.map(\.sync.firstPageIndex) + syncs.map(\.firstPageIndex))
        let anchorPages = Set((old + entries.values).compactMap(\.anchor?.pageIndex))
        guard let epoch = syncPages.filter({ $0 < lowest }).max(),
            let anchor = anchorPages.filter({ $0 < epoch }).max()
        else { return (model, changed, 0) }
        return (model, changed, anchor)
    }

    /// Reads which pauses arrived since the last scan, and pulls the facts owed back to the earliest.
    private func readPauses() async throws {
        var state = try store.scanState(deviceID: deviceID)
        let changes = try await source.recordingChanges(deviceID: deviceID)
        let pauses = ScanState.Mark(count: changes.count, last: changes.map(\.at.millis).max())
        guard pauses != state.pauses else { return }
        let new = changes.filter { $0.at.millis > state.pauses.last ?? .min }
        state.pull(new.count == pauses.count - state.pauses.count ? new.map(\.at).min() : CaptureInstant(millis: .min))
        state.pauses = pauses
        try store.setScanState(state, deviceID: deviceID)
    }
}
