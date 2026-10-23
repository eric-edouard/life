import Foundation
import Timeline

/// The recording light's brightness, in the steps the app offers; the raw value is the `SetLEDBrightness` level, out
/// of 100. The command takes 0 to 100, and 0 asks for the light off: with it, people nearby can't tell the Pendant
/// records. UNVERIFIED on hardware (docs/voice/pendant.md): whether the firmware applies any level, and whether 0 means off.
public enum LightBrightness: Int, CaseIterable, Sendable, Identifiable {
    case off = 0
    case dimmest = 10
    case low = 35
    case medium = 65
    case bright = 100

    public var id: Self { self }

    public var level: UInt32 { UInt32(rawValue) }
}

extension CaptureStatus {
    /// When the recording going on now began: the latest change the Pendant confirmed, when that was a resume and it
    /// is confirmed recording now. `nil` when it isn't, or when nothing says when it started (it was already on when
    /// Life first heard from it, or it came back on while out of reach).
    /// ponytail: a pause and resume both made out of reach leave no change, so "since" stays at the earlier resume.
    public func recordingSince(_ changes: [RecordingChange]) -> Date? {
        guard case .recording = recording, let latest = changes.max(by: { $0.at < $1.at }), latest.kind == .resumed
        else { return nil }
        return Date(timeIntervalSince1970: Double(latest.at.millis) / 1000)
    }
}
