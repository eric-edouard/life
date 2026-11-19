import UIKit

/// The background task's id, read by its own expiry handler.
final class Awake: @unchecked Sendable {
    var id = UIBackgroundTaskIdentifier.invalid
    /// Ends the task once: the expiry handler and the normal end may both come.
    func end() {
        guard id != .invalid else { return }
        let ended = id
        id = .invalid
        UIApplication.shared.endBackgroundTask(ended)
    }
}
