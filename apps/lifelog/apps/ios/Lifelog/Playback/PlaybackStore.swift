import AVFoundation
import AudioPipeline
import Library
import Observation
import Timeline

/// Plays one clip file, app-wide: the cut of a voice a card asks about. Played out loud, the Pendant hears
/// it, so the span is kept from transcription (`PlaybackQuiet`): stored in the library, where the uploader leaves its
/// audio out, and sent to the server when it closes.
@Observable
final class PlaybackStore {
    /// What the player is doing, kept in step with it: it also pauses on its own (end, interruption, route change).
    private(set) var isPlaying = false {
        didSet { updateQuiet() }
    }

    /// Which recording plays (the caller's id), so one lights at a time; `nil` once stopped.
    private(set) var playingID: String?
    /// Where the player is in the file, in seconds, about 10 times a second while it plays; the split stays when paused.
    private(set) var position: Double = 0

    /// Where a seek begins: the player reports its time before the seek lands, and the position never shows less.
    @ObservationIgnored private var seekStart: Double = 0
    @ObservationIgnored private let sync: SyncStore?
    @ObservationIgnored private let library: LibraryStore?
    @ObservationIgnored private let player = PlaybackStore.makePlayer()
    @ObservationIgnored private var observers: [Any] = []
    @ObservationIgnored private var statusWatch: Task<Void, Never>?
    @ObservationIgnored private var clipEnd: Task<Void, Never>?
    /// Where the clip's span ends in the file, to time its end again after a pause.
    @ObservationIgnored private var spanEnd: Double?
    /// A whole file that plays to its end also lets the audio session go (a clip's span ends through `stop`).
    @ObservationIgnored private var itemEnd: NSObjectProtocol?
    /// Playing out loud, the Pendant hears it: the span is kept from transcription (`PlaybackQuiet`).
    @ObservationIgnored private var quiet = PlaybackQuiet()
    @ObservationIgnored private var outLoud = PlaybackStore.routeIsOutLoud()
    /// Stores the spans one after another, so a stale guess never lands after the span's end.
    @ObservationIgnored private var quietSaves: Task<Void, Never>?

    init(library: LibraryStore?, sync: SyncStore?) {
        self.library = library
        self.sync = sync
        statusWatch = Task { [weak self, player] in
            for await status in Observations({ player.timeControlStatus }) {
                self?.isPlaying = status != .paused
            }
        }
        observeRoute()
        observers.append(
            player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 10), queue: .main) {
                [weak self] time in
                MainActor.assumeIsolated {
                    if let self, time.isNumeric { self.position = max(time.seconds, self.seekStart) }
                }
            })
    }

    /// Plays `file` from `start` seconds, and for `length` seconds when given (a clip is a span of its job's audio).
    /// `id` names the recording for whoever shows where it is (`playingID`).
    func play(_ file: URL, from start: Double = 0, for length: Double? = nil, id: String? = nil) {
        // `.playback` plays through the ring/silent switch, which mutes the default `.soloAmbient`; nothing else of the
        // app plays or records through the session (the Pendant's capture is Bluetooth, not AVAudioSession).
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)
        let item = AVPlayerItem(url: file)
        itemEnd.map(NotificationCenter.default.removeObserver)
        itemEnd = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.stop() } }
        player.replaceCurrentItem(with: item)
        playingID = id
        position = start
        seekStart = start
        if start > 0 { player.seek(to: CMTime(seconds: start, preferredTimescale: 600)) }
        player.play()
        spanEnd = length.map { start + $0 }
        endSpan(after: length)
    }

    /// Stops the clip `seconds` from now (`nil`: it plays to the file's end).
    private func endSpan(after seconds: Double?) {
        clipEnd?.cancel()
        clipEnd = seconds.map { seconds in
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(seconds))
                if !Task.isCancelled { self?.stop() }
            }
        }
    }

    /// Holds the clip where it is: `playingID` and `position` stay, so its words keep their split.
    func pause() {
        clipEnd?.cancel()
        player.pause()
    }

    /// Goes on from where `pause` held it.
    func resume() {
        player.play()
        endSpan(after: spanEnd.map { max($0 - position, 0) })
    }

    func stop() {
        clipEnd?.cancel()
        itemEnd.map(NotificationCenter.default.removeObserver)
        itemEnd = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
        playingID = nil
        position = 0
        seekStart = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Speaker, AirPlay or headphones: whether the Pendant hears it.
    private func observeRoute() {
        observers.append(
            NotificationCenter.default.addObserver(
                forName: AVAudioSession.routeChangeNotification, object: AVAudioSession.sharedInstance(), queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.outLoud = Self.routeIsOutLoud()
                    self.updateQuiet()
                }
            })
    }

    /// Opens, extends or closes the quiet span as the player and the route change, and stores it in the library,
    /// where the uploader leaves its audio out; a closed one is posted to the server through the outbox.
    private func updateQuiet() {
        guard let update = quiet.update(outLoud: isPlaying && outLoud, at: CaptureInstant(.now)) else { return }
        let seconds = update.span.lowerBound.distance(to: update.span.upperBound) / 1000
        switch update.change {
        case .opened: appEvent("playback.quiet_opened", ["route": Self.routeTypes()])
        case .closed: appEvent("playback.quiet_closed", ["seconds": "\(seconds)"])
        case .extended: break
        }
        guard let library else { return }
        let previous = quietSaves
        let sync = sync
        quietSaves = Task {
            await previous?.value
            do {
                try await library.setPlaybackQuiet(update.span)
            } catch {
                _ = report(error)
            }
            // Closed, it goes to the server too, in pieces it accepts. A crash while playing leaves the span on this
            // phone only: uploads still leave its audio out.
            guard update.change == .closed, let sync else { return }
            for piece in Self.pieces(of: update.span) {
                await sync.perform(.playbackQuiet(from: piece.lowerBound.date, to: piece.upperBound.date))
            }
        }
    }

    /// The server keeps a quiet range of at most 11 minutes: a longer span goes as 10-minute pieces.
    nonisolated static func pieces(of span: Range<CaptureInstant>) -> [Range<CaptureInstant>] {
        stride(from: span.lowerBound.millis, to: span.upperBound.millis, by: 600_000).map {
            CaptureInstant(millis: $0)..<CaptureInstant(millis: min($0 + 600_000, span.upperBound.millis))
        }
    }

    private static func routeIsOutLoud() -> Bool {
        PlaybackQuiet.isOutLoud(
            AVAudioSession.sharedInstance().currentRoute.outputs.map { ($0.portType.rawValue, $0.portName) })
    }

    /// Output port types only: a device's name can carry the owner's.
    private static func routeTypes() -> String {
        AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portType.rawValue).joined(separator: ",")
    }

    /// AVFoundation objects take part in Swift Observation only once `isObservationEnabled` is on, and it can only be
    /// turned on before the first `AVPlayer` exists. Off, `Observations` of the player's `timeControlStatus` never
    /// yields past its first value.
    private static func makePlayer() -> AVPlayer {
        if !AVPlayer.isObservationEnabled { AVPlayer.isObservationEnabled = true }
        let player = AVPlayer()
        player.actionAtItemEnd = .pause
        return player
    }
}
