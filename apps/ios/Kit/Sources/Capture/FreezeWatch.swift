import Foundation
import Synchronization

/// Decides when the capture is frozen. On Oct 21 the Pendant streamed for 3 h over a live link and iOS kept waking the
/// app, but no task ran in it, `DrainCoordinator.watchStall` included. The coordinator stamps `beat` from its own actor
/// every `DrainCoordinator.beatInterval`; a plain GCD timer (`FreezeWatch`) reads it every `period`. Only time the
/// process actually ran counts: a fire more than two periods after the last one followed a suspension and adds nothing,
/// so a phone asleep in a pocket never trips it.
struct FreezeDetector: Sendable {
    static let period: TimeInterval = 15
    /// Running time without a new beat after which the capture is frozen: four missed beats.
    static let limit = 4 * TimeInterval(DrainCoordinator.beatInterval.components.seconds)
    private var lastFire: Date?
    private var lastBeat: Date?
    private var stuckFor: TimeInterval = 0

    /// One timer fire: returns whether the capture is frozen.
    mutating func fire(at now: Date, beat: Date) -> Bool {
        defer { lastFire = now }
        guard beat == lastBeat, let lastFire else {
            lastBeat = beat
            stuckFor = 0
            return false
        }
        let ran = now.timeIntervalSince(lastFire)
        if ran <= 2 * Self.period { stuckFor += ran }
        return stuckFor >= Self.limit
    }
}

public enum FreezeWatch {
    /// Crashes the app once the capture is frozen. iOS relaunches a crashed Bluetooth app and hands its link back
    /// (TN3115; seen on Oct 18 after a CPU kill), and the crash report shows where every thread was stuck. Nothing is
    /// lost: only durable pages are ACKed. Keep the timer for as long as the capture runs.
    public static func start(beat: @escaping @Sendable () -> Date) -> any DispatchSourceTimer {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "life.freeze-watch"))
        let detector = Mutex(FreezeDetector())
        timer.schedule(deadline: .now() + FreezeDetector.period, repeating: FreezeDetector.period)
        timer.setEventHandler {
            if detector.withLock({ $0.fire(at: .now, beat: beat()) }) {
                fatalError("Capture frozen: no coordinator beat for \(Int(FreezeDetector.limit)) s of running")
            }
        }
        timer.resume()
        return timer
    }
}
