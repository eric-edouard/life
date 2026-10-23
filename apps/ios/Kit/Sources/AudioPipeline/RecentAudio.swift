import Foundation
import SourceStore
import Timeline

/// The newest audio on the phone, for the Pendant's button: what was said in the minutes before a press.
public enum RecentAudio {
    /// The device's newest stored pages, enough for the `seconds` before the newest audio, as capture audio: silence
    /// where none was stored. While audio is stored a page opens about every 1.5 s (docs/pendant.md), so one page a
    /// second covers the window. Only the clock syncs from those pages on are read.
    public static func source(seconds: Int64, store: SourceStore, deviceID: String) async throws -> SourceAudio {
        let pages = try await store.newestPages(deviceID: deviceID, limit: Int(seconds)).compactMap {
            try? AudioPage($0)
        }
        let clock = try await ClockModel.load(store, deviceID: deviceID, from: pages.first?.index ?? 0)
        return SourceAudio(store: store, deviceID: deviceID, pages: pages, clock: clock)
    }

    /// Waits until the newest stored audio reaches `time` (the Pendant's clock), at most `timeout`: the pages up to a
    /// press reach the phone a few seconds after it, or already did when the press itself came late.
    public static func settle(until time: Date, store: SourceStore, deviceID: String, timeout: Duration) async throws {
        let deadline = ContinuousClock.now + timeout
        let millis = Int64(time.timeIntervalSince1970 * 1000)
        while ContinuousClock.now < deadline {
            let newest = try await store.newestPages(deviceID: deviceID, limit: 1).first.flatMap { try? AudioPage($0) }
            let end = newest.map { page in
                page.deviceMillis
                    + (page.runs.last.map { $0.offsetMillis + Int64($0.count) * CaptureTimeline.packetMillis } ?? 0)
            }
            if let end, end >= millis { return }
            try await Task.sleep(for: .milliseconds(200))
        }
    }

    /// The `seconds` before `end` as Ogg Opus, rendered as fragments are. The window is wall time: phone time is capture
    /// time.
    public static func ogg(last seconds: Int64, before end: Date, store: SourceStore, deviceID: String, to url: URL)
        async throws -> PreparedFile
    {
        let to = CaptureInstant(end)
        guard let window = TimeMap(segments: [to.advanced(by: -seconds * 1000)..<to]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        return try await PreparedAudio.render(
            window, from: source(seconds: seconds, store: store, deviceID: deviceID), to: url)
    }
}
