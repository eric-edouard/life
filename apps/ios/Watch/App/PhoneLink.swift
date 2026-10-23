import Foundation
import Glance
import Observation
import WatchConnectivity
import WidgetKit

/// The Watch's side of WatchConnectivity: the glance the iPhone sends, and splits, pauses and resumes sent back. The Watch never hears from the Pendant itself, so all it can say is what the iPhone last knew.
@Observable
final class PhoneLink: NSObject {
    /// A split, which the iPhone saves at the time it was asked here.
    enum Mark: Equatable {
        case idle
        case sending
        /// The iPhone saved it.
        case marked(Date)
        case failed(String)
    }

    /// A pause or resume on its way to the iPhone, which answers once the Pendant confirmed it or it stopped waiting.
    enum Control: Equatable {
        case idle
        case sending(RecordingGlance.Request)
        case failed(String)
    }

    /// One link for the app and the face buttons' intents, which run in this process too.
    static let shared = PhoneLink()

    private(set) var glance = RecordingGlance.stored()
    private(set) var mark = Mark.idle
    private(set) var control = Control.idle

    @ObservationIgnored private let session = WCSession.default

    /// `live` false (previews) leaves WatchConnectivity alone.
    private init(live: Bool = true) {
        super.init()
        guard live else { return }
        session.delegate = self
        session.activate()
    }

    #if DEBUG
        /// Previews: what the iPhone last sent, and a moment or a pause in some state, with no iPhone behind it.
        static func preview(_ glance: RecordingGlance?, mark: Mark = .idle, control: Control = .idle) -> PhoneLink {
            let link = PhoneLink(live: false)
            link.glance = glance
            link.mark = mark
            link.control = control
            return link
        }
    #endif

    /// The Watch offers a split only while the iPhone is in reach.
    func split() async {
        let at = Date.now.timeIntervalSince1970
        guard await reachable() else {
            mark = .failed("Your iPhone isn't in reach, so nothing was split.")
            return
        }
        mark = .sending
        do {
            let reply = try await send([WatchMessage.split: at])
            let markedAt = (reply[WatchMessage.markedAt] as? Double).map(Date.init(timeIntervalSince1970:))
            let error = reply[WatchMessage.error] as? String
            mark = markedAt.map { .marked($0) } ?? .failed(error ?? "Life didn't answer.")
        } catch {
            mark = .failed("Your iPhone didn't answer, so nothing was split.")
        }
    }

    /// Runs on the iPhone through the same request as Shortcuts and the control, and returns once the iPhone
    /// answers: the Pendant confirmed, or it stopped waiting. Meanwhile the glance it sends says "Pausing…".
    func set(_ request: RecordingGlance.Request) async {
        control = .sending(request)
        guard await reachable() else {
            control = .failed("Your iPhone isn't in reach, so nothing was sent.")
            return
        }
        do {
            let reply = try await send([WatchMessage.setRecording: request == .resume])
            control = (reply[WatchMessage.error] as? String).map(Control.failed) ?? .idle
        } catch {
            control = .failed("Your iPhone didn't answer in time. The status above is what it last knew.")
        }
    }

    /// Whether the iPhone can take a message now. Just launched (from a complication or a face button), the session
    /// may still be activating.
    /// ponytail: polls 2 s; wait on `sessionReachabilityDidChange` if that proves short.
    func reachable() async -> Bool {
        for _ in 0..<10 where !session.isReachable {
            try? await Task.sleep(for: .milliseconds(200))
        }
        return session.isReachable
    }

    private func send(_ message: [String: Any]) async throws -> [String: Any] {
        nonisolated(unsafe) let message = message
        return try await withCheckedThrowingContinuation { continuation in
            session.sendMessage(
                message,
                replyHandler: { @Sendable reply in
                    nonisolated(unsafe) let reply = reply
                    continuation.resume(returning: reply)
                },
                errorHandler: { @Sendable error in continuation.resume(throwing: error) })
        }
    }

    private func receive(_ data: Data?) {
        guard let data, let new = try? JSONDecoder().decode(RecordingGlance.self, from: data), new != glance else {
            return
        }
        let change = glance.map(new.change(from:)) ?? .state
        glance = new
        new.store()
        // The complication shows no sound; newer evidence keeps its reading confirmed.
        guard change == .state || change == .evidence else { return }
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Whether WatchConnectivity still holds something for this wake.
    var hasContentPending: Bool { session.hasContentPending }
}

extension PhoneLink: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: (any Error)?
    ) {
        let data = session.receivedApplicationContext[WatchMessage.glance] as? Data
        Task { @MainActor in receive(data) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext context: [String: Any]) {
        let data = context[WatchMessage.glance] as? Data
        Task { @MainActor in receive(data) }
    }

    /// The complication's transfers, which wake the Watch to redraw.
    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        let data = userInfo[WatchMessage.glance] as? Data
        Task { @MainActor in receive(data) }
    }
}
