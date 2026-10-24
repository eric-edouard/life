import AppIntents
import Foundation
import Glance
import WidgetKit

// The face buttons of the large complication (Modular's large slot, the Smart Stack). Compiled into the complications
// so a button can name them, but they run in the Watch app (`allowedExecutionTargets`, watchOS 27), which owns the
// WatchConnectivity session: watchOS starts the app in the background for the tap. The iPhone does the work through
// the same request paths as the Watch app's own buttons (`WatchRelay`). See docs/decisions.md, "Face buttons try the background".

/// Pauses or resumes, as the face showed: never a blind toggle.
struct FaceRecordingIntent: AppIntent {
    static let title: LocalizedStringResource = "Pause or Resume from the Watch Face"
    static let isDiscoverable = false
    static var supportedModes: IntentModes { [.background, .foreground(.dynamic)] }
    static var allowedExecutionTargets: IntentExecutionTargets { .main }

    @Parameter(title: "Recording") var value: Bool

    init() {}

    init(value: Bool) {
        self.value = value
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
            let request: RecordingGlance.Request = value ? .resume : .pause
            let link = PhoneLink.shared
            FaceNote.show("Sending…", for: 30)
            try await reachPhone()
            await link.set(request)
            if case .failed(let reason) = link.control {
                FaceNote.show("Not sent", detail: reason)
            } else if await link.confirms(request) {
                FaceNote.clear()
            } else {
                // The iPhone took it; the glance says "Pausing…" until the Pendant confirms, if it got here.
                FaceNote.show("Sent · not confirmed")
            }
        #endif
        return .result()
    }
}

/// Splits the conversation here, as the iPhone's scissors do. Offered only while the Watch knows the Pendant records.
struct FaceSplitIntent: AppIntent {
    static let title: LocalizedStringResource = "Split from the Watch Face"
    static let isDiscoverable = false
    static var supportedModes: IntentModes { [.background, .foreground(.dynamic)] }
    static var allowedExecutionTargets: IntentExecutionTargets { .main }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
            FaceNote.show("Sending…", for: 30)
            try await reachPhone()
            await PhoneLink.shared.split()
            FaceNote.show(PhoneLink.shared.mark)
        #endif
        return .result()
    }
}

#if !WIDGET_EXTENSION
    extension AppIntent {
        /// WatchConnectivity promises the iPhone only to a Watch app in the foreground or "running with a high
        /// priority in the background", so a background tap may find it out of reach. Then the app comes forward,
        /// where it is, as the tap that opened the app did before.
        @MainActor
        fileprivate func reachPhone() async throws {
            guard await !PhoneLink.shared.reachable(), systemContext.currentMode.canContinueInForeground else { return }
            try await continueInForeground(nil, alwaysConfirm: false)
        }
    }

    extension PhoneLink {
        /// Whether the glance the iPhone sends back shows the Pendant confirmed the request, within a few seconds.
        fileprivate func confirms(_ request: RecordingGlance.Request) async -> Bool {
            let target: RecordingGlance.Microphone = request == .pause ? .paused : .recording
            for _ in 0..<12 {
                if case .confirmed(target, _) = glance?.reading(now: .now) { return true }
                try? await Task.sleep(for: .milliseconds(250))
            }
            return false
        }
    }

    extension FaceNote {
        fileprivate static func show(_ mark: PhoneLink.Mark) {
            switch mark {
            case .marked(let at): show("Split at \(at.moment)")
            case .failed(let reason): show("Not sent", detail: reason)
            case .idle, .sending: clear()
            }
        }
    }
#endif

/// What the last face tap did, for a minute on the face in place of the status: the Watch app writes it, the
/// complication reads it.
nonisolated struct FaceNote: Codable, Equatable {
    var text: String
    /// The whole reason, for VoiceOver.
    var detail: String?
    var until: Date

    static func stored() -> FaceNote? {
        AppGroup.defaults.data(forKey: AppGroup.Key.faceNote).flatMap {
            try? JSONDecoder().decode(FaceNote.self, from: $0)
        }
    }

    static func show(_ text: String, detail: String? = nil, for seconds: TimeInterval = 60) {
        let note = FaceNote(text: text, detail: detail, until: .now + seconds)
        AppGroup.defaults.set(try? JSONEncoder().encode(note), forKey: AppGroup.Key.faceNote)
        WidgetCenter.shared.reloadAllTimelines()
    }

    static func clear() {
        AppGroup.defaults.removeObject(forKey: AppGroup.Key.faceNote)
        WidgetCenter.shared.reloadAllTimelines()
    }
}
