import AVFoundation
import AudioPipeline
import Library
import MediaPlayer
import Observation
import Timeline

/// Playback feature store, app-wide: plays one conversation's capture range from the derived 10-minute AAC files.
///
/// The files are stitched into an `AVMutableComposition` when playback starts, so nothing is decoded ahead and a long
/// recording is never held in memory. Time runs linearly from the conversation's start (`PlaybackTimeline`): stretches
/// without audio play as silence, so every transcript time lands exactly. Audio plays whether or not text exists.
@Observable
final class PlaybackStore {
    struct Item: Equatable {
        let id: UUID
        var title: String
        let range: Range<CaptureInstant>
    }

    /// Where an item's audio is.
    enum Source: Equatable {
        /// The derived playback files, by capture time.
        case derived
        /// A recording imported from the old app: its own file.
        case imported
        /// A file of its own (a clip the server cut), `fileMillis` into it at the item's start.
        case file(URL, fileMillis: Int64)
    }

    enum Status: Equatable {
        case loading
        case ready
        /// No playback file covers the conversation yet, or the files could not be opened.
        case unavailable(String)
    }

    static let skipMillis: Int64 = 15_000

    private(set) var item: Item?
    private(set) var status = Status.ready
    /// What the player is doing, kept in step with it: it also pauses on its own (end, interruption, route change).
    private(set) var isPlaying = false {
        didSet { updateQuiet() }
    }
    /// The capture instant playing now, updated ten times a second while playing.
    private(set) var position: CaptureInstant?
    /// Stretches of the item that hold no audio and play as silence.
    private(set) var gaps: [Range<CaptureInstant>] = []
    /// Conversation pages on screen. One player at a time: a page's own player controls the page's conversation,
    /// so the mini player hides while a page shows.
    var pagesOnScreen = 0

    /// Rebuilds evicted playback files before they play; set by `PlaybackHost`.
    @ObservationIgnored var sync: SyncStore?
    /// Finds the previous and next conversations and imported audio, and keeps quiet spans; set by `PlaybackHost`.
    @ObservationIgnored var library: LibraryStore?
    @ObservationIgnored private let player = PlaybackStore.makePlayer()
    @ObservationIgnored private var timeline: PlaybackTimeline?
    @ObservationIgnored private var loading: Task<Void, Never>?
    @ObservationIgnored private var ticks: Task<Void, Never>?
    @ObservationIgnored private var observers: [Any] = []
    @ObservationIgnored private var statusWatch: Task<Void, Never>?
    /// The owner wants it playing; an interruption resumes only then.
    @ObservationIgnored private var playRequested = false
    @ObservationIgnored private var resumeAfterInterruption = false
    /// Playing out loud, the Pendant hears it: the span is kept from transcription (`PlaybackQuiet`).
    @ObservationIgnored private var quiet = PlaybackQuiet()
    @ObservationIgnored private var outLoud = PlaybackStore.routeIsOutLoud()
    /// Stores the spans one after another, so a stale guess never lands after the span's end.
    @ObservationIgnored private var quietSaves: Task<Void, Never>?

    /// One for the app (`AppDelegate.playback`): each adds Lock Screen command targets that are never removed.
    /// Previews pass `live: false`, which leaves the audio session and the Lock Screen alone.
    init(live: Bool = true) {
        statusWatch = Task { [weak self, player] in
            for await status in Observations({ player.timeControlStatus }) {
                self?.playerChanged(status)
            }
        }
        guard live else { return }
        observeSession()
        registerRemoteCommands()
    }

    // MARK: Intents

    /// Opens a conversation at `instant` (its start when `nil`) and starts playing when `autoplay`. The same
    /// conversation, unchanged, only seeks. `span` loads only that stretch of it (a clip), so only its own files are
    /// rebuilt when evicted.
    func open(
        _ conversation: CachedConversation, at instant: CaptureInstant? = nil, span: Range<CaptureInstant>? = nil,
        autoplay: Bool
    ) {
        open(
            id: conversation.id, title: Self.title(conversation), range: span ?? conversation.range,
            source: conversation.isImported ? .imported : .derived, at: instant, autoplay: autoplay)
    }

    /// Opens `range` of audio by capture time: a conversation, audio not uploaded yet, or a clip (`id` its own).
    func open(
        id: UUID, title: String, range: Range<CaptureInstant>, source: Source = .derived,
        at instant: CaptureInstant? = nil, autoplay: Bool
    ) {
        if item?.id == id, item?.range == range, status == .ready {
            item?.title = title
            seek(to: instant ?? position ?? range.lowerBound)
            if autoplay { play() }
            return
        }
        loading?.cancel()
        // The old item's clock would keep moving `position` on its own timeline while the new one loads.
        ticks?.cancel()
        player.pause()
        player.replaceCurrentItem(with: nil)
        item = Item(id: id, title: title, range: range)
        position = instant ?? range.lowerBound
        status = .loading
        gaps = []
        loading = Task {
            do {
                let (timeline, url) = try await audio(of: id, source: source, range: range)
                guard !Task.isCancelled else { return }
                try await load(timeline, from: url)
                status = .ready
                seek(to: position ?? range.lowerBound)
                if autoplay { play() }
            } catch is CancellationError {
            } catch {
                status = .unavailable(report(error))
            }
        }
    }

    func play() {
        guard status == .ready, let timeline else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        outLoud = Self.routeIsOutLoud()
        if let position, timeline.offset(of: position) >= timeline.durationMillis {
            seek(to: timeline.range.lowerBound)
        }
        playRequested = true
        player.play()
        isPlaying = true
        updateNowPlaying()
    }

    func pause() {
        playRequested = false
        player.pause()
        isPlaying = false
        updateNowPlaying()
    }

    func togglePlayPause() { isPlaying ? pause() : play() }

    /// Exact to the millisecond, clamped to the conversation.
    func seek(to instant: CaptureInstant) {
        guard let timeline else { return }
        let offset = timeline.offset(of: instant)
        position = timeline.instant(atOffset: offset)
        player.seek(to: PlaybackTimeline.time(offset), toleranceBefore: .zero, toleranceAfter: .zero)
        updateNowPlaying()
    }

    func skip(by millis: Int64) {
        guard let position else { return }
        seek(to: position.advanced(by: millis))
    }

    /// The conversation before (`-1`) or after (`1`) the current one, playing from its start.
    func advance(_ direction: Int) {
        guard let item, let library else { return }
        let autoplay = isPlaying
        Task {
            let next =
                direction < 0
                ? try? await library.conversations(before: item.range.lowerBound, limit: 1).first
                : try? await library.conversations(after: item.range.lowerBound, limit: 1).first
            if let next { open(next, autoplay: autoplay) }
        }
    }

    /// Stops and dismisses the player.
    func stop() {
        loading?.cancel()
        ticks?.cancel()
        playRequested = false
        player.pause()
        player.replaceCurrentItem(with: nil)
        (item, timeline, position, isPlaying, status, gaps) = (nil, nil, nil, false, .ready, [])
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: Loading

    /// Reads the sidecars off the main actor; after the first read of a launch they come from memory.
    @concurrent
    private static func timeline(for range: Range<CaptureInstant>, deviceID: String) async throws -> PlaybackTimeline {
        let timeline = PlaybackTimeline(range: range, manifest: try audio().manifest(deviceID: deviceID))
        guard !timeline.pieces.isEmpty else { throw Unavailable.noAudio }
        return timeline
    }

    /// Where `range` of a conversation plays from: an imported recording's own file, run by run, or the derived files.
    private func audio(of id: UUID, source: Source, range: Range<CaptureInstant>) async throws -> (
        PlaybackTimeline, (String) -> URL
    ) {
        if case .file(let url, let fileMillis) = source {
            let timeline = PlaybackTimeline(
                range: range, file: url.lastPathComponent, runs: [FileRun(interval: range, fileMillis: fileMillis)])
            return (timeline, { url.deletingLastPathComponent().appending(path: $0) })
        }
        if source == .imported, let library, let imported = try await library.importedAudio(of: id) {
            let folder = library.importedAudio
            let timeline = PlaybackTimeline(range: range, file: imported.file, runs: imported.runs)
            return (timeline, { folder.appending(path: $0) })
        }
        // Files evicted to save space are encoded again first, while the player shows it is loading.
        try await sync?.restorePlayback(covering: range)
        let derived = try Self.audio()
        return (
            try await Self.timeline(for: range, deviceID: Self.deviceID),
            { derived.audioURL(file: $0, deviceID: Self.deviceID) }
        )
    }

    /// Loads the timeline's composition (`PlaybackTimeline.composition`); `url` finds a piece's file.
    private func load(_ timeline: PlaybackTimeline, from url: (String) -> URL) async throws {
        let composition = try await timeline.composition(url)
        try Task.checkCancellation()
        let playerItem = AVPlayerItem(asset: composition)
        player.replaceCurrentItem(with: playerItem)
        // Seeks before the item is ready would be dropped.
        for await state in Observations({ playerItem.status }) {
            if state == .readyToPlay { break }
            if state == .failed { throw playerItem.error ?? Unavailable.noAudio }
        }
        try Task.checkCancellation()
        self.timeline = timeline
        gaps = timeline.gaps
        ticks?.cancel()
        ticks = Task { [weak self] in
            for await time in playerItem.integratedTimeline.periodicTimes(forInterval: PlaybackTimeline.time(100)) {
                guard let self, let timeline = self.timeline else { return }
                position = timeline.instant(atOffset: Int64((time.seconds * 1000).rounded()))
                updateQuiet()
            }
        }
    }

    /// The player paused or started on its own. Paused at the end, it is done: an interruption won't restart it.
    private func playerChanged(_ status: AVPlayer.TimeControlStatus) {
        let playing = status != .paused
        // Without a ready item the time is invalid: its seconds are NaN, which `Int64` traps on.
        let seconds = player.currentTime().seconds
        if !playing, let timeline, seconds.isFinite, Int64(seconds * 1000) >= timeline.durationMillis - 100 {
            playRequested = false
        }
        guard playing != isPlaying else { return }
        isPlaying = playing
        updateNowPlaying()
    }

    // MARK: System

    /// Another app or a call took the audio session: playback stops, and resumes only when the system recommends it.
    private func observeSession() {
        let session = AVAudioSession.sharedInstance()
        let center = NotificationCenter.default
        observers.append(
            center.addObserver(of: session, for: .didBecomeInactive) {
                [weak self] (message: AVAudioSession.DidBecomeInactiveMessage) in
                guard let self, case .systemInterruption = message.deactivationResult else { return }
                resumeAfterInterruption = playRequested
            })
        observers.append(
            center.addObserver(of: session, for: .resumptionRecommendation) { [weak self] message in
                guard let self, resumeAfterInterruption else { return }
                resumeAfterInterruption = false
                if message.recommendation == .shouldResume { play() }
            })
        // Speaker, AirPlay or headphones: whether the Pendant hears it.
        observers.append(
            center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) {
                [weak self] _ in
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

    /// Lock screen and Control Center.
    private func registerRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.skipForwardCommand.preferredIntervals = [NSNumber(value: Self.skipMillis / 1000)]
        center.skipBackwardCommand.preferredIntervals = [NSNumber(value: Self.skipMillis / 1000)]
        let handlers: [(MPRemoteCommand, (MPRemoteCommandEvent) -> Void)] = [
            (center.playCommand, { [weak self] _ in self?.play() }),
            (center.pauseCommand, { [weak self] _ in self?.pause() }),
            (center.togglePlayPauseCommand, { [weak self] _ in self?.togglePlayPause() }),
            (center.skipForwardCommand, { [weak self] _ in self?.skip(by: Self.skipMillis) }),
            (center.skipBackwardCommand, { [weak self] _ in self?.skip(by: -Self.skipMillis) }),
            (center.nextTrackCommand, { [weak self] _ in self?.advance(1) }),
            (center.previousTrackCommand, { [weak self] _ in self?.advance(-1) }),
            (
                center.changePlaybackPositionCommand,
                { [weak self] event in
                    guard let self, let timeline, let event = event as? MPChangePlaybackPositionCommandEvent else {
                        return
                    }
                    seek(to: timeline.instant(atOffset: Int64(event.positionTime * 1000)))
                }
            ),
        ]
        for (command, handler) in handlers {
            command.addTarget { [weak self] event in
                guard self?.item != nil else { return .noActionableNowPlayingItem }
                handler(event)
                return .success
            }
        }
    }

    private func updateNowPlaying() {
        guard let item, let timeline, let position else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: item.title,
            MPMediaItemPropertyPlaybackDuration: Double(timeline.durationMillis) / 1000,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: Double(timeline.offset(of: position)) / 1000,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
        ]
    }

    // MARK: Helpers

    /// AVFoundation objects take part in Swift Observation only once `isObservationEnabled` is on, and it can only be
    /// turned on before the first `AVPlayer` or `AVPlayerItem` exists. Off, `Observations` of the item's status and
    /// the player's `timeControlStatus` never yield past their first value: loading never finished. This store makes
    /// every player and item in the app, so it turns it on.
    private static func makePlayer() -> AVPlayer {
        if !AVPlayer.isObservationEnabled { AVPlayer.isObservationEnabled = true }
        let player = AVPlayer()
        player.actionAtItemEnd = .pause
        return player
    }

    enum Unavailable: Error, CustomStringConvertible {
        case noAudio
        var description: String { "No audio has been prepared for this conversation yet." }
    }

    static var deviceID: String { CaptureStore.deviceID }

    /// Where playable audio lives: the derived files, or the demo library's.
    nonisolated static func audio() throws -> DerivedAudioDirectory {
        #if DEBUG
            if FixtureLibrary.isRequested { return FixtureLibrary.audio }
        #endif
        return try DerivedAudioDirectory.standard()
    }

    static func title(_ conversation: CachedConversation) -> String {
        conversation.shownTitle ?? ConversationRow.untitledName(start: conversation.startAt)
    }

    #if DEBUG
        /// Previews: nothing loaded.
        static func preview() -> PlaybackStore { PlaybackStore(live: false) }

        /// Previews: `conversation` loaded and paused at `position`, with no audio behind it.
        static func preview(
            _ conversation: CachedConversation, at position: CaptureInstant, status: Status = .ready
        ) -> PlaybackStore {
            let store = preview()
            store.item = Item(id: conversation.id, title: title(conversation), range: conversation.range)
            store.position = position
            store.status = status
            return store
        }
    #endif
}
