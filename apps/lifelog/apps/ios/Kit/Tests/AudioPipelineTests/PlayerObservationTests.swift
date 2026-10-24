import AVFoundation
import Foundation
import Testing
import Timeline

@testable import AudioPipeline

/// The app's player waits on `Observations` of `AVPlayerItem.status` and `AVPlayer.timeControlStatus`. Those only
/// update once `AVPlayer.isObservationEnabled` is on (before any player exists); without it playback stayed
/// "Loading audio" forever. This checks the whole path on a real derived file: ready, playing, ticking.
@MainActor
@Test(.timeLimit(.minutes(1))) func observedPlayerBecomesReadyPlaysAndTicks() async throws {
    if !AVPlayer.isObservationEnabled { AVPlayer.isObservationEnabled = true }
    let directory = DerivedAudioDirectory(
        url: FileManager.default.temporaryDirectory.appending(path: "player-observation-\(UUID().uuidString)"))
    defer { try? FileManager.default.removeItem(at: directory.url) }
    let segment = try directory.writePlayback(
        deviceID: "pendant-1", pages: 0...1, start: CaptureInstant(millis: 0), millis: 2_000
    ) { range in range.map { Float(sin(Double($0) * 0.1) * 0.2) } }
    let item = AVPlayerItem(url: directory.audioURL(file: segment.file, deviceID: "pendant-1"))
    let player = AVPlayer(playerItem: item)
    player.isMuted = true

    for await status in Observations({ item.status }) {
        if status == .readyToPlay { break }
        try #require(status != .failed, "\(String(describing: item.error))")
    }
    player.play()
    for await status in Observations({ player.timeControlStatus }) where status == .playing { break }
    for await time in item.integratedTimeline.periodicTimes(forInterval: CMTime(value: 100, timescale: 1000))
    where time.seconds > 0.2 {
        break
    }
    player.pause()
}
