import AVFoundation
import Synchronization
import Timeline

/// One derived playback file: a stretch of one continuous span, AAC in `.m4a`, about `maxMillis` long at most. Offset 0
/// of the file is `interval.lowerBound`, and the file is exactly `interval.millis` long.
public struct PlaybackSegment: Sendable, Equatable, Codable {
    /// About 10 minutes, so a file stays small enough to seek and stream without loading a recording whole.
    public static let maxMillis: Int64 = 600_000

    public var deviceID: String
    /// File name inside the device's derived directory.
    public var file: String
    /// Source pages the audio came from (some may hold no audio).
    public var pages: ClosedRange<UInt64>
    public var interval: Range<CaptureInstant>
    public var decodeGaps: [DecodeGap]
    var windows: [StoredWindow]
    /// The audio file was deleted to save space (`DerivedAudioWorker.evictPlayback`); this sidecar and its analysis
    /// stay, and `DerivedAudioWorker.rebuildPlayback` encodes the file again from the source packs. `nil` in older
    /// sidecars.
    public var evicted: Bool?

    public var activity: [ActivityWindow] { windows.map(\.window) }
}

/// The device's playback files, in capture time order.
public struct PlaybackManifest: Sendable, Equatable {
    public let segments: [PlaybackSegment]

    public init(segments: [PlaybackSegment]) {
        self.segments = segments.sorted { $0.interval.lowerBound < $1.interval.lowerBound }
    }
}

/// Derived audio lives in Application Support/lifelog/derived, one directory per device: playback files and their
/// JSON sidecars. All of it is rebuilt from the source packs, so it is excluded from backup and may be deleted.
public struct DerivedAudioDirectory: Sendable {
    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    public static func standard() throws -> Self {
        var url = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ).appending(path: "lifelog/derived", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        return Self(url: url)
    }

    /// Every playback sidecar of the device, from memory while the directory hasn't changed. Sidecars are written
    /// atomically, so each write moves the directory's date; a changed directory decodes only the sidecars written
    /// since. Thousands of sidecars take seconds to decode, and screens ask for this on every open.
    public func manifest(deviceID: String) throws -> PlaybackManifest {
        let directory = directory(deviceID)
        // Read before listing: a write landing in between leaves a stale date behind, which the next call sees.
        guard let modified = try modified(deviceID: deviceID) else { return PlaybackManifest(segments: []) }
        let cached = Self.manifests.withLock { $0[directory] }
        if let cached, cached.modified == modified { return cached.manifest }
        var files: [String: ManifestCache.File] = [:]
        for (name, written) in try sidecarFiles(deviceID: deviceID) {
            files[name] =
                try cached?.files[name].flatMap { $0.written == written ? $0 : nil }
                ?? ManifestCache.File(written: written, segment: segment(deviceID: deviceID, named: name))
        }
        let fresh = ManifestCache(
            modified: modified, files: files, manifest: PlaybackManifest(segments: files.values.map(\.segment)))
        Self.manifests.withLock { $0[directory] = fresh }
        return fresh.manifest
    }

    private struct ManifestCache {
        struct File {
            var written: Date
            var segment: PlaybackSegment
        }

        var modified: Date
        var files: [String: File]
        var manifest: PlaybackManifest
    }

    /// By device directory, for the whole process: the worker and playback read the same sidecars.
    private static let manifests = Mutex<[URL: ManifestCache]>([:])

    /// When the device's directory last gained or replaced a file (sidecars are written atomically, so each write
    /// moves it); `nil` while it doesn't exist.
    public func modified(deviceID: String) throws -> Date? {
        let directory = directory(deviceID)
        guard FileManager.default.fileExists(atPath: directory.path) else { return nil }
        return try directory.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
    }

    /// The device's playback sidecars by file name, each with when it was last written.
    public func sidecarFiles(deviceID: String) throws -> [(name: String, modified: Date)] {
        let directory = directory(deviceID)
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.contentModificationDateKey]
        ).filter { $0.lastPathComponent.hasSuffix(".segment.json") }.map {
            (
                $0.lastPathComponent,
                try $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate ?? .distantPast
            )
        }
    }

    /// One playback sidecar, by its file name (`sidecarFiles`).
    public func segment(deviceID: String, named name: String) throws -> PlaybackSegment {
        try JSONDecoder().decode(
            PlaybackSegment.self, from: Data(contentsOf: directory(deviceID).appending(path: name)))
    }

    /// Decode gaps of the device: bad packets inside playback files and pages that could not be read at all.
    public func decodeGaps(deviceID: String) throws -> [DecodeGap] {
        try manifest(deviceID: deviceID).segments.flatMap(\.decodeGaps)
            + sidecars(deviceID, suffix: ".pages.json", as: [DecodeGap].self).flatMap(\.self)
    }

    /// Playback files whose sidecar is here but whose audio is not (a restored backup), for the worker to rebuild.
    /// Evicted files are left out: they are rebuilt when played.
    public func missingAudio() throws -> [(deviceID: String, pages: ClosedRange<UInt64>)] {
        try segments {
            $0.evicted != true && !FileManager.default.fileExists(atPath: audioURL($0.deviceID, pages: $0.pages).path)
        }
    }

    /// Playback files analyzed before Silero ran on the phone, for the worker to rebuild with every analyzer.
    public func staleAnalysis() throws -> [(deviceID: String, pages: ClosedRange<UInt64>)] {
        try segments { !$0.windows.contains { $0.analyzer == SileroDetector.analyzer } }
    }

    private func segments(
        where isIncluded: (PlaybackSegment) -> Bool
    ) throws -> [(deviceID: String, pages: ClosedRange<UInt64>)] {
        try devices().flatMap { device in
            try manifest(deviceID: device).segments.filter(isIncluded).map { (device, $0.pages) }
        }
    }

    func devices() throws -> [String] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(
            at: url, includingPropertiesForKeys: nil, options: .skipsHiddenFiles
        ).compactMap { $0.lastPathComponent.removingPercentEncoding }
    }

    func directory(_ deviceID: String) -> URL {
        url.appending(
            path: deviceID.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? deviceID,
            directoryHint: .isDirectory)
    }

    public func audioURL(_ deviceID: String, pages: ClosedRange<UInt64>) -> URL {
        directory(deviceID).appending(path: "\(pages.lowerBound)-\(pages.upperBound).m4a")
    }

    public func sidecarURL(_ deviceID: String, pages: ClosedRange<UInt64>) -> URL {
        directory(deviceID).appending(path: "\(pages.lowerBound)-\(pages.upperBound).segment.json")
    }

    /// The pages a sidecar's file name says it covers (`sidecarURL`'s inverse).
    public static func pages(ofSidecar name: String) -> ClosedRange<UInt64>? {
        let bounds = name.prefix { $0 != "." }.split(separator: "-").compactMap { UInt64($0) }
        guard bounds.count == 2, bounds[0] <= bounds[1] else { return nil }
        return bounds[0]...bounds[1]
    }

    func segment(_ deviceID: String, pages: ClosedRange<UInt64>) -> PlaybackSegment? {
        try? JSONDecoder().decode(PlaybackSegment.self, from: Data(contentsOf: sidecarURL(deviceID, pages: pages)))
    }

    func write(_ segment: PlaybackSegment) throws {
        try JSONEncoder().encode(segment).write(
            to: sidecarURL(segment.deviceID, pages: segment.pages), options: .atomic)
    }

    func write(pageGaps: [DecodeGap], deviceID: String, job: ClosedRange<UInt64>) throws {
        let url = directory(deviceID).appending(path: "\(job.lowerBound)-\(job.upperBound).pages.json")
        try FileManager.default.createDirectory(at: directory(deviceID), withIntermediateDirectories: true)
        try JSONEncoder().encode(pageGaps).write(to: url, options: .atomic)
    }

    private func sidecars<T: Decodable>(_ deviceID: String, suffix: String, as: T.Type) throws -> [T] {
        let directory = directory(deviceID)
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasSuffix(suffix) }
            .map { try JSONDecoder().decode(T.self, from: Data(contentsOf: $0)) }
    }
}

/// AAC-LC, 16 kHz mono, 24 kbps: about 11 MB per hour, sample-exact seeking, played by `AVPlayer` everywhere.
enum PlaybackEncoding {
    static var settings: [String: Any] {
        [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: PendantAudio.sampleRate, AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 24_000,
        ]
    }
}

/// `ActivityWindow` as stored in a sidecar.
struct StoredWindow: Sendable, Equatable, Codable {
    var start: Int64
    var end: Int64
    var activity: Activity
    var confidence: Double
    var analyzer: String

    init(_ window: ActivityWindow) {
        start = window.interval.lowerBound.millis
        end = window.interval.upperBound.millis
        activity = window.activity
        confidence = window.confidence
        analyzer = window.analyzer
    }

    var window: ActivityWindow {
        ActivityWindow(
            interval: CaptureInstant(millis: start)..<CaptureInstant(millis: end), activity: activity,
            confidence: confidence, analyzer: analyzer)
    }
}
