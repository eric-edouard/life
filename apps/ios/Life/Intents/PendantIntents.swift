import AppIntents
import Capture
import Incidents
import SwiftUI

/// "Am I recording?" Answers from the last snapshot the app wrote, so it never claims fresher than the evidence.
struct RecordingStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Pendant Recording Status"
    static let description = IntentDescription("Says whether your Pendant is recording, and how recently it said so.")
    static var supportedModes: IntentModes { .background }

    /// The sentence alone: a snippet under it only repeated it.
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let snapshot = PendantSnapshot.load() ?? PendantSnapshot(link: .notConnected)
        return .result(dialog: "\(snapshot.sentence(now: .now))")
    }
}

struct PauseRecordingIntent: AppIntent {
    static let title: LocalizedStringResource = "Pause Pendant Recording"
    static let description = IntentDescription(
        "Asks your Pendant to stop recording. Already-recorded audio still syncs.")
    static var supportedModes: IntentModes { .background }

    @Dependency private var capture: CaptureStore

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let outcome = await capture.request(.pause)
        return .result(dialog: "\(outcome.sentence(for: .pause))")
    }
}

struct ResumeRecordingIntent: AppIntent {
    static let title: LocalizedStringResource = "Resume Pendant Recording"
    static let description = IntentDescription("Asks your Pendant to start recording again.")
    static var supportedModes: IntentModes { .background }

    @Dependency private var capture: CaptureStore

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let outcome = await capture.request(.resume)
        return .result(dialog: "\(outcome.sentence(for: .resume))")
    }
}

/// For a Personal Automation (an app closes, Wi-Fi joins, the charger connects, a time): wakes Life without
/// opening it, even after a force-quit, and starts the same run a Bluetooth sync does (docs/voice/pendant.md).
struct SyncLifeIntent: AppIntent {
    static let title: LocalizedStringResource = "Sync Life"
    static let description = IntentDescription(
        "Wakes Life in the background to sync the Pendant, upload and pull.")
    static var supportedModes: IntentModes { .background }

    @Dependency private var sync: SyncStore

    func perform() async throws -> some IntentResult & ProvidesDialog {
        .result(dialog: "\(await sync.syncForShortcut())")
    }
}

nonisolated struct LifeShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: RecordingStatusIntent(),
            phrases: [
                "Am I recording in \(.applicationName)", "Is my Pendant recording in \(.applicationName)",
                "\(.applicationName) recording status",
            ], shortTitle: "Recording Status", systemImageName: "record.circle")
        AppShortcut(
            intent: SyncLifeIntent(),
            phrases: ["Sync \(.applicationName)", "Sync my Pendant in \(.applicationName)"],
            shortTitle: "Sync Life", systemImageName: "arrow.triangle.2.circlepath")
        AppShortcut(
            intent: PauseRecordingIntent(),
            phrases: ["Pause recording in \(.applicationName)", "Pause my Pendant in \(.applicationName)"],
            shortTitle: "Pause Recording", systemImageName: "pause.circle")
        AppShortcut(
            intent: ResumeRecordingIntent(),
            phrases: ["Resume recording in \(.applicationName)", "Resume my Pendant in \(.applicationName)"],
            shortTitle: "Resume Recording", systemImageName: "record.circle")
    }
}

extension CaptureStore.RequestOutcome {
    nonisolated func sentence(for intent: RecordingIntent) -> String {
        let verb = intent == .pause ? "Pause" : "Resume"
        switch self {
        case .confirmed:
            return intent == .pause
                ? "Recording paused. The Pendant confirmed it." : "Recording. The Pendant confirmed it."
        case .pending:
            return "\(verb) requested — waiting for the Pendant to confirm."
        case .failed(.rejected(_, let reason)):
            return "The Pendant refused the \(verb.lowercased()) (\(reason)). Open Life to check what it's doing."
        case .failed(.unconfirmed):
            return "The Pendant didn't confirm the \(verb.lowercased()). Open Life to check what it's doing."
        case .notConnected:
            return
                "The Pendant isn't connected, so nothing was sent. Holding its button about 2 s also toggles recording."
        }
    }
}
