import Foundation
import Glance
import WatchConnectivity

/// Sends the glance to the Watch, and takes its splits, pauses and resumes.
///
/// The application context carries the latest glance (free, latest wins), sound at most every `soundStep`. The complication's budgeted transfers, which wake the Watch to redraw, go only on a change of state,
/// never for newer evidence or sound; with few left they're kept for recording and connection changes.
final class WatchRelay: NSObject {
    /// ponytail: kept back from the daily complication budget for recording and connection changes.
    private static let reserve = 10

    /// Pauses or resumes; says why not, or `nil` once confirmed or waiting for the Pendant. Set by `CaptureStore`.
    var setRecording: ((Bool) async -> String?)?
    /// Splits the conversation at the time the Watch asked, as the scissors do; says why not. Set by `AppDelegate`.
    var split: ((Date) async -> String?)?

    private var sent: RecordingGlance?
    private var sentAt = Date.distantPast
    private let session: WCSession? = WCSession.isSupported() ? .default : nil

    override init() {
        super.init()
        session?.delegate = self
        session?.activate()
    }

    func send(_ glance: RecordingGlance, now: Date) {
        guard let session, session.activationState == .activated, session.isPaired, session.isWatchAppInstalled
        else { return }
        let change = sent.map(glance.change(from:)) ?? .state
        guard change != .none, change != .sound || now.timeIntervalSince(sentAt) >= RecordingGlance.soundStep,
            let data = try? JSONEncoder().encode(glance)
        else { return }
        try? session.updateApplicationContext([WatchMessage.glance: data])
        let essential = glance.connected != sent?.connected || glance.microphone != sent?.microphone
        sent = glance
        sentAt = now
        guard change == .state, session.isComplicationEnabled else { return }
        let left = session.remainingComplicationUserInfoTransfers
        guard left > Self.reserve || (left > 0 && essential) else { return }
        session.transferCurrentComplicationUserInfo([WatchMessage.glance: data])
    }

    private func set(recording: Bool) async -> [String: Any] {
        guard let setRecording else { return [WatchMessage.error: "Life isn't ready yet."] }
        return await setRecording(recording).map { [WatchMessage.error: $0] } ?? [:]
    }

    private func split(at: Date) async -> [String: Any] {
        guard let split else { return [WatchMessage.error: "Life isn't ready yet."] }
        return await split(at).map { [WatchMessage.error: "The split wasn't saved: \($0)"] }
            ?? [WatchMessage.markedAt: at.timeIntervalSince1970]
    }
}

extension WatchRelay: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: (any Error)?
    ) {}

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    /// The Watch moved to another iPhone and back: start again.
    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    /// A split, a pause or a resume while the iPhone is reachable: the Watch waits for the answer.
    nonisolated func session(
        _ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void
    ) {
        // WatchConnectivity lets the reply be sent once, from any thread.
        nonisolated(unsafe) let reply = replyHandler
        if let recording = message[WatchMessage.setRecording] as? Bool {
            Task { @MainActor in reply(await set(recording: recording)) }
        } else if let seconds = message[WatchMessage.split] as? Double {
            Task { @MainActor in reply(await split(at: Date(timeIntervalSince1970: seconds))) }
        } else {
            reply([:])
        }
    }
}
