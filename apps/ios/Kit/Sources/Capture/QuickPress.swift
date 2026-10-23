import Foundation
import PendantProtocol

/// A live press on the Pendant's button, as `DrainCoordinator.quickPresses` delivers it: it asks an AI about the last
/// minute (docs/voice/pendant.md). Replays at connect and presses while paused never come here.
public struct QuickPress: Sendable, Equatable {
    /// The same press reported again keeps it: the since-boot press count and the Pendant's own time of the press.
    /// Without that time, a fresh id.
    public var id: String
    /// When it was pressed: the Pendant's time when plausible (`PressClock.pressedAt`), else when the phone received it.
    public var at: Date

    public init(id: String, at: Date) {
        self.id = id
        self.at = at
    }
}

/// Reads presses from the button's short events; the same press reported again (a status replayed at connect) is
/// dropped.
struct PressReader {
    private var last: String?

    mutating func press(_ button: ButtonStatus, deviceID: String, at: Date) -> QuickPress? {
        let id =
            button.eventTimestampMillis.map { "pendant:\(deviceID):\(button.shortPressesSinceBoot):\($0)" }
            ?? "pendant:\(UUID().uuidString)"
        guard id != last else { return nil }
        last = id
        return QuickPress(id: id, at: at)
    }
}
