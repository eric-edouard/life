import AVFoundation
import AudioPipeline
import Library
import Observation
import Timeline

/// Plays one clip file, app-wide: the cut of a voice a card asks about (`ClipAudio`). Played out loud, the Pendant hears
/// it, so the span is kept from transcription (`PlaybackQuiet`): stored in the library, where the uploader leaves its
/// audio out, and sent to the server when it closes.
@Observable
final class PlaybackStore {
    /// What the player is doing, kept in step with it: it also pauses on its own (end, interruption, route change).
    private(set) var isPlaying = false {
        didSet { updateQuiet() }
    }

    @ObservationIgnored private let sync: SyncStore?
    @ObservationIgnored private let library: LibraryStore?
    @ObservationIgnored private let player = PlaybackStore.makePlayer()
    @ObservationIgnored private var observers: [Any] = []
    @ObservationIgnored private var statusWatch: Task<Void, Never>?
    @ObservationIgnored private var clipEnd: Task<Void, Never>?
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
    }

    /// Plays `file` from `start` seconds, and for `length` seconds when given (a clip is a span of its job's audio).
    func play(_ file: URL, from start: Double = 0, for length: Double? = nil) {
        let item = AVPlayerItem(url: file)
        player.replaceCurrentItem(with: item)
        if start > 0 { player.seek(to: CMTime(seconds: start, preferredTimescale: 600)) }
        player.play()
        clipEnd?.cancel()
        clipEnd = length.map { length in
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(length))
                if !Task.isCancelled { self?.stop() }
            }
        }
    }

    func stop() {
        clipEnd?.cancel()
        player.pause()
        player.replaceCurrentItem(with: nil)
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
