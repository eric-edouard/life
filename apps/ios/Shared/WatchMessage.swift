import Foundation
import Glance

/// What the iPhone and the Watch say to each other over WatchConnectivity (property-list dictionaries).
nonisolated enum WatchMessage {
    /// iPhone to Watch: the JSON of the latest `RecordingGlance`.
    static let glance = "glance"
    /// Watch to iPhone: resume (`true`) or pause (`false`). Only while the iPhone is in reach, never queued: a pause
    /// that lands hours later would be wrong.
    static let setRecording = "setRecording"
    /// Watch to iPhone: split the conversation at this time (seconds since 1970), as the scissors do. Only while the
    /// iPhone is in reach, which is also when the Watch knows the Pendant is recording.
    static let split = "split"
    /// The iPhone's answer to a split: saved at this time, or why not.
    static let markedAt = "markedAt"
    static let error = "error"
}

nonisolated extension RecordingGlance {
    /// On the Watch: the last glance the iPhone sent, for the app and its complications.
    static func stored() -> RecordingGlance? {
        AppGroup.defaults.data(forKey: AppGroup.Key.recordingGlance).flatMap {
            try? JSONDecoder().decode(RecordingGlance.self, from: $0)
        }
    }

    func store() {
        AppGroup.defaults.set(try? JSONEncoder().encode(self), forKey: AppGroup.Key.recordingGlance)
    }

    /// What a tap on the Watch asks for: the opposite of the Pendant's last report while connected. Nothing while a
    /// request waits, or when there's no state to flip.
    func toggle(now: Date) -> Request? {
        guard connected, pendingRequest(now: now) == nil else { return nil }
        return switch microphone {
        case .recording: .pause
        case .paused: .resume
        case .unrecognized, nil: nil
        }
    }
}

nonisolated extension RecordingGlance.Request {
    /// A complication's tap: opens the Watch app, which sends what the face showed, never a blind toggle.
    var url: URL? { URL(string: "lifelog://\(rawValue)") }

    init?(url: URL) {
        guard url.scheme == "lifelog", let host = url.host() else { return nil }
        self.init(rawValue: host)
    }
}
