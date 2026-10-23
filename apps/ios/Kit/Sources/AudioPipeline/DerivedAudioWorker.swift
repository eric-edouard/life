import AVFoundation
import Foundation
import SourceStore
import Timeline

/// Consumes the source store's derived job queue: decodes each job's pages, writes playback files and labels activity.
///
/// It only reads the source store and only writes the job queue and the derived directory, so a failure here can never
/// touch ACK or capture: the job goes back to the queue with backoff (`SourceStore.failJob`). Each finished playback
/// file has a sidecar written last, which is the checkpoint: a retried job skips finished files.
public actor DerivedAudioWorker {
    private let store: SourceStore
    private let output: DerivedAudioDirectory
    private let canRunHeavyWork: @Sendable () -> Bool
    /// Rebuilds under way, by playback file: a second caller waits for the first instead of writing the same file.
    private var rebuilds: [URL: Task<Void, any Error>] = [:]
    /// Decoded audio held at once: 30 s.
    static let chunkMillis: Int64 = 30_000
    /// Playback files are kept this long after their audio ends: a week.
    static let keepSeconds: TimeInterval = 7 * 86_400
    /// A file written this recently is never evicted (just rebuilt, perhaps playing): a day.
    static let graceSeconds: TimeInterval = 86_400

    public init(
        store: SourceStore, output: DerivedAudioDirectory,
        canRunHeavyWork: @escaping @Sendable () -> Bool = DerivedAudioWorker.deviceAllowsHeavyWork
    ) {
        self.store = store
        self.output = output
        self.canRunHeavyWork = canRunHeavyWork
    }

    /// False while the phone is hot (thermal state serious or critical) or in Low Power Mode.
    public static func deviceAllowsHeavyWork() -> Bool {
        let info = ProcessInfo.processInfo
        return ![.serious, .critical].contains(info.thermalState) && !info.isLowPowerModeEnabled
    }

    /// Runs due jobs until the queue is empty, the task is cancelled or the device should rest. Returns how many
    /// jobs completed. Checked between jobs and chunks; a job interrupted by cancellation is retried later.
    /// `finished` is handed each playback file's sidecar of a job, written now or before, ahead of the job's completion:
    /// a crash in between leaves the job to run again, and it hands them again.
    @discardableResult
    public func run(finished: @Sendable (PlaybackSegment) async throws -> Void) async -> Int {
        var completed = 0
        while !Task.isCancelled, canRunHeavyWork(), let job = try? await store.claimJob() {
            do {
                try await process(job, finished: finished)
                try await store.completeJob(job.id)
                completed += 1
            } catch {
                // Cancellation (capture needs the phone, the background task expired) is not the job's fault.
                if Task.isCancelled {
                    try? await store.releaseJob(job.id)
                } else {
                    try? await store.failJob(job.id, error: String(describing: error))
                }
            }
        }
        return completed
    }

    /// Playback files analyzed before Silero ran on the phone are rebuilt: their audio is removed, so the job skips no
    /// piece, and `encode` rewrites the sidecar. A hidden marker (not in backups) makes later calls one file read.
    public func requeueStaleAnalysis() async throws {
        let marker = output.url.appending(path: ".analysis")
        guard (try? String(contentsOf: marker, encoding: .utf8)) != SileroDetector.analyzer else { return }
        for (device, pages) in try output.staleAnalysis() {
            // An evicted file is skipped by jobs: unmark it so this one re-encodes and gains Silero's windows.
            if var segment = output.segment(device, pages: pages), segment.evicted == true {
                segment.evicted = nil
                try output.write(segment)
            }
            try? FileManager.default.removeItem(at: output.audioURL(device, pages: pages))
            try await store.requeueJob(deviceID: device, indices: pages)
        }
        try Data(SileroDetector.analyzer.utf8).write(to: marker, options: .atomic)
    }

    func process(_ job: DerivedJob, finished: @Sendable (PlaybackSegment) async throws -> Void) async throws {
        let scan = try await PageScan.scan(store, deviceID: job.deviceID, indices: job.indices)
        try FileManager.default.createDirectory(at: output.directory(job.deviceID), withIntermediateDirectories: true)
        if !scan.gaps.isEmpty { try output.write(pageGaps: scan.gaps, deviceID: job.deviceID, job: job.indices) }
        let clock = try await ClockModel.load(store, deviceID: job.deviceID, from: job.indices.lowerBound)
        let source = SourceAudio(store: store, deviceID: job.deviceID, pages: scan.pages, clock: clock)
        // A sidecar without its audio (restored from a backup) is rebuilt, not skipped. An evicted one is finished:
        // only `rebuildPlayback` writes its file again, so the two never write the same file.
        let done = { [output] (pages: ClosedRange<UInt64>) -> PlaybackSegment? in
            guard let segment = output.segment(job.deviceID, pages: pages),
                segment.evicted == true
                    || FileManager.default.fileExists(atPath: output.audioURL(job.deviceID, pages: pages).path)
            else { return nil }
            return segment
        }
        for span in source.spans {
            for piece in Self.pieces(span) {
                let segment = if let done = done(piece.pages) { done } else { try await encode(piece, from: source) }
                try await finished(segment)
            }
        }
    }

    /// Cuts a span into playback files at page boundaries, each at most about `PlaybackSegment.maxMillis` long.
    /// The pieces tile the span; a short silence before a cut stays in the earlier file.
    static func pieces(_ span: CaptureSpan) -> [(pages: ClosedRange<UInt64>, interval: Range<CaptureInstant>)] {
        var pieces: [(pages: ClosedRange<UInt64>, interval: Range<CaptureInstant>)] = []
        for run in span.runs {
            if let last = pieces.last,
                last.pages.upperBound == run.page
                    || last.interval.lowerBound.distance(to: run.end) <= PlaybackSegment.maxMillis
            {
                pieces[pieces.count - 1] = (last.pages.lowerBound...run.page, last.interval.lowerBound..<run.end)
            } else {
                if let last = pieces.last {
                    pieces[pieces.count - 1].interval = last.interval.lowerBound..<run.start
                }
                pieces.append((run.page...run.page, run.start..<run.end))
            }
        }
        return pieces
    }

    private func encode(
        _ piece: (pages: ClosedRange<UInt64>, interval: Range<CaptureInstant>), from source: SourceAudio
    ) async throws -> PlaybackSegment {
        var energy: [ActivityWindow] = []
        let silero = try SileroDetector()
        var gaps: [DecodeGap] = []
        let final = try await writeAudio(piece.pages, piece.interval, from: source) { chunk, start in
            energy += EnergyDetector.windows(chunk.samples, start: start)
            try silero.append(chunk.samples)
            gaps += chunk.gaps
        }
        let classified = try SoundClassifier.windows(file: final, start: piece.interval.lowerBound)
        let segment = try PlaybackSegment(
            deviceID: source.deviceID, file: final.lastPathComponent, pages: piece.pages,
            interval: piece.interval, decodeGaps: gaps,
            windows: (energy + classified
                + silero.windows(start: piece.interval.lowerBound, millis: piece.interval.millis))
                .map(StoredWindow.init))
        try output.write(segment)
        return segment
    }

    /// Encodes `interval` as the playback file of `pages`: written beside it, moved into place once whole. `analyze`
    /// sees each chunk and where it starts.
    private func writeAudio(
        _ pages: ClosedRange<UInt64>, _ interval: Range<CaptureInstant>, from source: SourceAudio,
        analyze: (_ chunk: (samples: [Float], gaps: [DecodeGap]), _ start: CaptureInstant) throws -> Void = { _, _ in }
    ) async throws -> URL {
        let final = output.audioURL(source.deviceID, pages: pages)
        let partial = final.deletingPathExtension().appendingPathExtension("partial.m4a")
        let file = try AVAudioFile(
            forWriting: partial, settings: PlaybackEncoding.settings, commonFormat: .pcmFormatFloat32,
            interleaved: false)
        for start in stride(from: interval.lowerBound, to: interval.upperBound, by: Self.chunkMillis) {
            try Task.checkCancellation()
            let chunk = try await source.samples(start..<min(start.advanced(by: Self.chunkMillis), interval.upperBound))
            try file.write(from: PendantAudio.buffer(chunk.samples))
            try analyze(chunk, start)
            await Task.yield()
        }
        file.close()
        try? FileManager.default.removeItem(at: final)
        try FileManager.default.moveItem(at: partial, to: final)
        return final
    }

    // MARK: Eviction

    /// Deletes the playback files of every device whose audio ended over a week before `now`, to save space: they are
    /// about twice the size of the source packs. Each sidecar stays, analysis windows and decode gaps included, marked
    /// evicted. A file written in the last day stays. Returns how many files were deleted.
    @discardableResult
    public func evictPlayback(now: Date = .now) throws -> Int {
        let ended = CaptureInstant(now.addingTimeInterval(-Self.keepSeconds))
        let written = now.addingTimeInterval(-Self.graceSeconds)
        var count = 0
        for device in try output.devices() {
            let segments = try output.manifest(deviceID: device).segments
            for var segment in segments where segment.interval.upperBound < ended {
                let audio = output.audioURL(device, pages: segment.pages)
                guard
                    let modified = try? audio.resourceValues(forKeys: [.contentModificationDateKey])
                        .contentModificationDate,
                    modified < written
                else { continue }
                // Marked first: a crash in between leaves an evicted sidecar beside its file, never a file lost.
                if segment.evicted != true {
                    segment.evicted = true
                    try output.write(segment)
                }
                try FileManager.default.removeItem(at: audio)
                count += 1
            }
        }
        return count
    }

    /// Encodes the evicted playback files overlapping `range` again from the source packs and clears their mark, so
    /// they play. Their sidecars keep the analysis they had. Runs whatever the device's heat: the owner is waiting.
    /// Returns how many files were rebuilt.
    @discardableResult
    public func rebuildPlayback(deviceID: String, covering range: Range<CaptureInstant>) async throws -> Int {
        let evicted = try output.manifest(deviceID: deviceID).segments.filter {
            $0.evicted == true && $0.interval.overlaps(range)
        }
        for segment in evicted {
            let url = output.audioURL(deviceID, pages: segment.pages)
            if let running = rebuilds[url] {
                try await running.value
                continue
            }
            // Not cancelled with the caller: a file half rebuilt would be thrown away.
            let task = Task {
                let source = try await self.source(deviceID, pages: segment.pages)
                _ = try await self.writeAudio(segment.pages, segment.interval, from: source)
                var rebuilt = segment
                rebuilt.evicted = nil
                try self.output.write(rebuilt)
            }
            rebuilds[url] = task
            defer { rebuilds[url] = nil }
            try await task.value
        }
        return evicted.count
    }

    private func source(_ deviceID: String, pages: ClosedRange<UInt64>) async throws -> SourceAudio {
        let scan = try await PageScan.scan(store, deviceID: deviceID, indices: pages)
        let clock = try await ClockModel.load(store, deviceID: deviceID, from: pages.lowerBound)
        return SourceAudio(store: store, deviceID: deviceID, pages: scan.pages, clock: clock)
    }
}
