import AppIntents
import BackgroundTasks
import Library
import OwnerSettings
import ServerAPI
import SwiftUI
import UIKit

@main
struct LifelogApp: App {
    @UIApplicationDelegateAdaptor private var appDelegate: AppDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                // A fallback cycle while in the foreground only; background sync follows the Pendant's events.
                .task(id: scenePhase == .active) {
                    guard scenePhase == .active else { return }
                    await appDelegate.capture.resyncWhileActive()
                }
                // A pairing code scanned with the Camera (`lifelog://pair?…`), confirmed on screen first.
                .onOpenURL { url in
                    if let pairing = Pairing(link: url) { appDelegate.sync.offeredPairing = pairing }
                }
        }
        .environment(appDelegate.capture)
        .environment(\.library, appDelegate.library)
        .environment(appDelegate.sync)
        .environment(appDelegate.naming)
        .environment(appDelegate.playback)
        .environment(appDelegate.buttons)
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                Task { await appDelegate.capture.becameActive() }
                appDelegate.claimLocation()
            case .background: appDelegate.sync.wentToBackground()
            default: break
            }
        }
    }
}

/// iOS may relaunch the app in the background for a Bluetooth event (state restoration) without showing a
/// scene, so capture starts here rather than in a view.
final class AppDelegate: NSObject, UIApplicationDelegate {
    let capture: CaptureStore
    /// Opened at launch beside capture, so reading past conversations never waits for processing. `nil` when it
    /// can't be opened (written by a newer app, an unreadable file): it fails closed, and screens say so.
    let library: LibraryStore?
    /// The one processing driver: uploads, the outbox, the feed, the status every tab shows.
    lazy var sync = SyncStore(capture: capture, library: library)
    private let location = LocationRecorder()
    /// The voices to name, read by the Library, People and "Who's this?".
    lazy var naming = NamingQueue(library: library, sync: sync)
    /// The Pendant's button: built at launch, so a press that wakes the app in the background is answered.
    lazy var buttons = ButtonActions(capture: capture)
    /// Built at launch too: it hears new audio and presses in the background.
    lazy var copilot = Copilot(capture: capture, settings: .shared)
    /// Built when the first scene asks, not in a background relaunch: it registers the Lock Screen's commands.
    lazy var playback = PlaybackStore()

    override init() {
        _ = ScreenTiming.launched
        // Before any store opens: a restored library the owner chose replaces the live one.
        BackupStore.applyScheduledSwitch()
        library = Self.libraryAtLaunch()
        capture = CaptureStore()
        super.init()
        // Shortcuts and the Recording control may launch the app just to run an intent; it reaches capture here.
        let capture = capture
        AppDependencyManager.shared.add(dependency: capture)
        let sync = sync
        AppDependencyManager.shared.add(dependency: sync)
    }

    private static func libraryAtLaunch() -> LibraryStore? {
        #if DEBUG
            if FixtureLibrary.isRequested { return FixtureLibrary.open() }
        #endif
        do {
            return try LibraryStore(
                directory: URL.applicationSupportDirectory.appending(
                    path: "lifelog/library", directoryHint: .isDirectory),
                report: { _ = report($0) })
        } catch {
            _ = report(error)
            return nil
        }
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // How iOS launched this process, read before capture starts and sends a heartbeat. No content. launchOptions
        // is left out: it came empty on every launch, Bluetooth relaunches included (Oct 15–20). A new boot time means
        // the phone restarted.
        var boot = timeval()
        var size = MemoryLayout<timeval>.size
        sysctlbyname("kern.boottime", &boot, &size, nil, 0)
        let state = application.applicationState
        let launch = [
            "state": state == .active ? "active" : state == .inactive ? "inactive" : "background",
            "protectedData": "\(application.isProtectedDataAvailable)",
            "bootedAt": Date(timeIntervalSince1970: TimeInterval(boot.tv_sec)).ISO8601Format(),
            "sinceHeartbeatS": HealthReporter.saved?.lastSent.map { "\(Int(Date.now.timeIntervalSince($0)))" } ?? "",
        ]
        capture.onAudioSaved = { [sync, copilot] in
            sync.run(audio: true)
            copilot.poke()
        }
        // While the Copilot is on, a press asks it instead of the quick question.
        capture.onPress = { [buttons, copilot] in Settings.shared.copilotOn ? copilot.press() : buttons.handle($0) }
        // The Watch's scissors: the same split as the Pendant screen's.
        capture.watch.split = { [sync] at in await sync.perform(.split(at: at)) }
        capture.start()
        appEvent("app.launch", launch)
        startLocation()
        Task { [sync] in await sync.followNetwork() }
        application.registerForRemoteNotifications()
        // Handlers must be registered before launch ends. `.main` delivers the task on the main actor.
        BGTaskScheduler.shared.register(forTaskWithIdentifier: SyncStore.backgroundTaskID, using: .main) {
            [sync] task in
            MainActor.assumeIsolated { sync.handle(task) }
        }
        return true
    }

    /// Starts noting where the phone is, at launch in the foreground or a background relaunch. Fixes and visits go
    /// straight to the library: a background relaunch builds no pipeline to save one.
    private func startLocation() {
        claimLocation()
        location.start(paused: { [capture] in capture.status.lastKnownRecording?.value == .paused }) {
            [library] fix in
            try? await library?.record(fix)
        }
        location.monitorVisits { [library] visit in try? await library?.record(visit) }
    }

    /// Holds Always location once a Pendant is paired: at launch and whenever the app comes forward.
    func claimLocation() {
        if capture.hasKnownPendant { location.claim() }
    }

    /// Kept for the runs to send (`PushToken`) until the paired server has it.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        PushToken.keep(token)
    }

    /// The server's silent push (`"lifelog": "processing"`): words or a summary landed, or blocks are wanted. The alert
    /// (voices to name) goes through the notification center instead.
    func application(
        _ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]
    ) async -> UIBackgroundFetchResult {
        guard userInfo["lifelog"] as? String == "processing" else { return .noData }
        await sync.pushed()
        return .newData
    }
}

extension EnvironmentValues {
    /// The library opened at launch (`AppDelegate.library`); `nil` when it didn't open, and in previews without one.
    @Entry var library: LibraryStore?
}

extension Settings {
    /// The owner's choices, read by views and by the code that runs without one (alerts).
    static let shared = Settings(defaults: .standard, group: AppGroup.defaults)
}

extension LibraryStore {
    /// What screens say when the library didn't open at launch.
    static let notOpen = "lifelog couldn't open the library. The diagnostics report says why."
}
