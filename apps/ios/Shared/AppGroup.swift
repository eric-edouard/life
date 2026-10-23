import Foundation

/// The container the app shares with its widgets and controls (and, on the Watch, the app with its complications).
nonisolated enum AppGroup {
    /// `group.<LIFELOG_BUNDLE_ID>` (project.yml), from the target's Info.plist: a target without it is a build mistake.
    private static let id: String = {
        guard let id = Bundle.main.object(forInfoDictionaryKey: "LifelogAppGroup") as? String else {
            preconditionFailure("LifelogAppGroup missing from this target's Info.plist (project.yml)")
        }
        return id
    }()
    /// Falls back to the app's own defaults where the group isn't provisioned (unsigned simulator builds).
    /// UserDefaults is thread-safe; the SDK just doesn't mark it Sendable.
    nonisolated(unsafe) static let defaults = UserDefaults(suiteName: id) ?? .standard

    /// Every key the app shares with its widgets and the Watch. Never rename one: a reader on the old name finds nothing.
    enum Key {
        /// `PendantSnapshot`: widgets, the control and Shortcuts.
        static let pendantSnapshot = "pendantSnapshot"
        /// `RecordingGlance` as the Watch last received it.
        static let recordingGlance = "recordingGlance"
        /// The Watch face's note (`FaceNote`).
        static let faceNote = "faceNote"
        /// Provider quota evidence, kept independently so either widget can update its own reading.
        static let claudeUsage = "subscriptionUsage.claude"
        static let codexUsage = "subscriptionUsage.codex"
    }
}
