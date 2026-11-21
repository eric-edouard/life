#if os(iOS)
    import AVFoundation
#endif

/// The app's one audio session: the clip player and a dictation take turns at it. A lease is a turn. A new lease ends
/// the holder before it, and only the newest lease lets the session go, so a late `stop()` of a player never closes
/// the microphone a dictation opened after it.
@MainActor
public final class AudioSessionOwner {
    public enum Use: Sendable { case playback, recording }

    public struct Lease: Equatable, Sendable {
        let id: Int
        public let use: Use
    }

    /// Sets the session up for a use, or lets it go (`nil`).
    private let apply: (Use?) throws -> Void
    private var current: (lease: Lease, end: @MainActor () -> Void)?
    private var taken = 0

    public init(apply: @escaping (Use?) throws -> Void) { self.apply = apply }

    /// Ends the holder before (its `end`), then sets the session up for `use`, with no let-go between. `end` is told
    /// when a newer lease or an interruption takes the session; a failed set-up leaves no holder.
    public func take(_ use: Use, end: @escaping @MainActor () -> Void) throws -> Lease {
        let before = current
        current = nil
        before?.end()
        do {
            try apply(use)
        } catch {
            try? apply(nil)
            throw error
        }
        taken += 1
        let lease = Lease(id: taken, use: use)
        current = (lease, end)
        return lease
    }

    /// Lets the session go, unless a newer lease holds it.
    public func release(_ lease: Lease) {
        guard current?.lease == lease else { return }
        current = nil
        try? apply(nil)
    }

    /// The session went inactive. The system taking it (a call, Siri) ends the holder's turn; the app's own let-go,
    /// which can arrive after a newer lease took the session, ends nothing.
    public func sessionBecameInactive(byApp: Bool) {
        guard !byApp, let holder = current else { return }
        holder.end()
        release(holder.lease)
    }
}

#if os(iOS)
    extension AudioSessionOwner {
        /// The app's owner of `AVAudioSession.sharedInstance()`. The system taking it (a call, Siri) ends the holder.
        public static let shared: AudioSessionOwner = {
            let session = AVAudioSession.sharedInstance()
            let owner = AudioSessionOwner { use in
                switch use {
                // `.playback` plays through the ring/silent switch, which mutes the default `.soloAmbient`.
                case .playback?: try session.setCategory(.playback, mode: .spokenAudio)
                case .recording?: try session.setCategory(.record, mode: .measurement)
                case nil: try session.setActive(false, options: .notifyOthersOnDeactivation)
                }
                if use != nil { try session.setActive(true) }
            }
            _ = NotificationCenter.default.addObserver(
                forName: AVAudioSession.didBecomeInactiveNotification, object: session, queue: .main
            ) { note in
                let context =
                    note.userInfo?[AVAudioSession.deactivationContextKey] as? AVAudioSession.DeactivationContext
                let byApp = context?.source == .app
                MainActor.assumeIsolated { owner.sessionBecameInactive(byApp: byApp) }
            }
            return owner
        }()
    }
#endif
