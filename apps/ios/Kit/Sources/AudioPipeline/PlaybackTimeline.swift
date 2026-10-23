import AVFoundation
import Timeline

/// One conversation's audio as one continuous program. Offset 0 is `range.lowerBound` and capture time runs linearly,
/// so `offset = instant - range.lowerBound` everywhere, exactly like exported audio (docs/formats.md). Stretches no
/// playback file covers (not recorded, unreadable pages) play as silence and are listed in `gaps`; they are never cut,
/// so transcript times never shift.
public struct PlaybackTimeline: Sendable, Equatable {
    /// A stretch of one playback file.
    public struct Piece: Sendable, Equatable {
        public var file: String
        /// Milliseconds into the file.
        public var fileMillis: Range<Int64>
        /// Where it plays, in milliseconds from the start of the timeline.
        public var offset: Int64
    }

    public let range: Range<CaptureInstant>
    public let pieces: [Piece]
    public let gaps: [Range<CaptureInstant>]

    public init(range: Range<CaptureInstant>, manifest: PlaybackManifest) {
        self.init(
            range: range, files: manifest.segments.map { ($0.file, FileRun(interval: $0.interval, fileMillis: 0)) })
    }

    /// An imported recording: one file, played run by run (`FileRun`).
    public init(range: Range<CaptureInstant>, file: String, runs: [FileRun]) {
        self.init(range: range, files: runs.map { (file, $0) })
    }

    /// `files` sorted by start.
    private init(range: Range<CaptureInstant>, files: [(file: String, run: FileRun)]) {
        self.range = range
        var pieces: [Piece] = []
        var gaps: [Range<CaptureInstant>] = []
        var cursor = range.lowerBound
        for (file, run) in files where run.interval.overlaps(range) {
            // Overlapping files (a clock quirk) never play twice: each moment comes from the first file holding it.
            let start = max(run.interval.lowerBound, cursor)
            let end = min(run.interval.upperBound, range.upperBound)
            guard start < end else { continue }
            if cursor < start { gaps.append(cursor..<start) }
            let first = run.fileMillis + run.interval.lowerBound.distance(to: start)
            pieces.append(
                Piece(
                    file: file, fileMillis: first..<first + start.distance(to: end),
                    offset: range.lowerBound.distance(to: start)))
            cursor = end
        }
        if cursor < range.upperBound { gaps.append(cursor..<range.upperBound) }
        self.pieces = pieces
        self.gaps = gaps
    }

    public var durationMillis: Int64 { range.millis }

    /// Milliseconds from the start, clamped to the timeline.
    public func offset(of instant: CaptureInstant) -> Int64 {
        min(max(range.lowerBound.distance(to: instant), 0), durationMillis)
    }

    /// The capture instant playing at `offset`, clamped to the timeline.
    public func instant(atOffset offset: Int64) -> CaptureInstant {
        range.lowerBound.advanced(by: min(max(offset, 0), durationMillis))
    }

    /// The pieces stitched into what the player plays; holes and the ends stay empty, which plays as silence. `url`
    /// finds a piece's file. Each file is read with precise timing: without it AVFoundation places a time in an Ogg
    /// file (a job's audio from the server) by its average bitrate, and a clip 15 minutes in played 30 s early
    /// (Oct 15).
    nonisolated(nonsending) public func composition(_ url: (String) -> URL) async throws -> AVMutableComposition {
        let composition = AVMutableComposition()
        guard
            let track = composition.addMutableTrack(
                withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        else { return composition }
        // Kept by hand: an empty track's time range is invalid.
        var end: Int64 = 0
        for piece in pieces {
            let asset = AVURLAsset(url: url(piece.file), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
            guard let source = try await asset.loadTracks(withMediaType: .audio).first else { continue }
            if piece.offset > end {
                track.insertEmptyTimeRange(CMTimeRange(start: Self.time(end), end: Self.time(piece.offset)))
            }
            try track.insertTimeRange(
                CMTimeRange(start: Self.time(piece.fileMillis.lowerBound), end: Self.time(piece.fileMillis.upperBound)),
                of: source, at: Self.time(piece.offset))
            end = piece.offset + piece.fileMillis.upperBound - piece.fileMillis.lowerBound
        }
        if end < durationMillis {
            track.insertEmptyTimeRange(CMTimeRange(start: Self.time(end), end: Self.time(durationMillis)))
        }
        return composition
    }

    public static func time(_ millis: Int64) -> CMTime { CMTime(value: millis, timescale: 1000) }
}

extension DerivedAudioDirectory {
    /// The playback file named `file` of a device.
    public func audioURL(file: String, deviceID: String) -> URL {
        directory(deviceID).appending(path: file)
    }

    /// Encodes 16 kHz mono PCM as one playback file, then writes its sidecar last, like the worker. It is for fixtures
    /// and tests: there are no source pages behind it, so it carries no activity labels or decode gaps. `samples`
    /// returns the samples of a sample range; it is called in chunks, so a long file is never held whole.
    @discardableResult
    public func writePlayback(
        deviceID: String, pages: ClosedRange<UInt64>, start: CaptureInstant, millis: Int64,
        samples: (Range<Int>) -> [Float]
    ) throws -> PlaybackSegment {
        try FileManager.default.createDirectory(at: directory(deviceID), withIntermediateDirectories: true)
        let url = audioURL(deviceID, pages: pages)
        let file = try AVAudioFile(
            forWriting: url, settings: PlaybackEncoding.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let total = Int(millis) * PendantAudio.samplesPerMilli
        let chunk = Int(DerivedAudioWorker.chunkMillis) * PendantAudio.samplesPerMilli
        for first in stride(from: 0, to: total, by: chunk) {
            try file.write(from: PendantAudio.buffer(samples(first..<min(first + chunk, total))))
        }
        file.close()
        let segment = PlaybackSegment(
            deviceID: deviceID, file: url.lastPathComponent, pages: pages, interval: start..<start.advanced(by: millis),
            decodeGaps: [], windows: [])
        try write(segment)
        return segment
    }
}
