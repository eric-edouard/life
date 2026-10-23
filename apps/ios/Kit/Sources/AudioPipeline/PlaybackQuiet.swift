import Timeline

/// While this app plays a recording out loud, the Pendant hears it: the span becomes a quiet range (source playback),
/// like the owner dictating to the Mac, so it is never sent to transcription again. Pausing, stopping, finishing or a
/// switch to headphones closes the span; out loud again opens a new one. Padded for the room's echo.
public struct PlaybackQuiet: Sendable, Equatable {
    public enum Change: Sendable, Equatable {
        case opened, extended, closed
    }

    public static let paddingMillis: Int64 = 2_000
    /// How often an open span is stored again. Stored ahead by as much, so audio a slow drain hands over mid-playback
    /// is already covered, and a crash leaves at most this much of the room muted.
    public static let refreshMillis: Int64 = 30_000

    public private(set) var openedAt: CaptureInstant?
    private var storedAt: CaptureInstant?

    public init() {}

    /// Whether the route plays into the room: the built-in speaker, AirPlay, a car, a cable to speakers, or a Bluetooth
    /// speaker. Not headphones, a headset or the earpiece. `outputs` are `AVAudioSession` output ports' raw type and
    /// name. ponytail: Bluetooth audio carries no device kind, so head-worn ones are told by name; add a name when a
    /// pair of headphones turns out muted.
    public static func isOutLoud(_ outputs: [(type: String, name: String)]) -> Bool {
        outputs.contains { output in
            switch output.type {
            case "Speaker", "AirPlay", "HDMIOutput", "LineOut", "CarAudio": true
            case "BluetoothA2DPOutput", "BluetoothLE":
                !["airpods", "headphone", "headset", "earbud", "earphone", "buds", "powerbeats", "beats studio"]
                    .contains { output.name.lowercased().contains($0) }
            default: false
            }
        }
    }

    /// Follows the player at `now`; returns the padded span to store (it replaces the one stored with its start) when
    /// it opens, every `refreshMillis` while open, and when it closes.
    public mutating func update(outLoud: Bool, at now: CaptureInstant) -> (
        change: Change, span: Range<CaptureInstant>
    )? {
        switch (openedAt, outLoud) {
        case (nil, false):
            return nil
        case (nil, true):
            (openedAt, storedAt) = (now, now)
            return (.opened, now.advanced(by: -Self.paddingMillis)..<now.advanced(by: Self.refreshMillis))
        case (let start?, true):
            guard let storedAt, storedAt.distance(to: now) >= Self.refreshMillis else { return nil }
            self.storedAt = now
            return (.extended, start.advanced(by: -Self.paddingMillis)..<now.advanced(by: Self.refreshMillis))
        case (let start?, false):
            (openedAt, storedAt) = (nil, nil)
            return (.closed, start.advanced(by: -Self.paddingMillis)..<now.advanced(by: Self.paddingMillis))
        }
    }
}
