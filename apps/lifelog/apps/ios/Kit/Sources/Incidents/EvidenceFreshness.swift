import Capture
import Foundation

/// How much to trust a device fact by its age. "Unknown" and "last known" (stale) are legitimate states.
public enum EvidenceFreshness: Sendable, Equatable {
    case fresh
    /// Last known: true when observed, maybe not now.
    case stale
    /// Never observed.
    case unknown

    /// A connected Pendant speaks every couple of minutes; a connection silent longer has stalled
    /// (`CaptureConfiguration.stallTimeout`), so anything younger is current.
    /// ponytail: one threshold for every fact; split per fact when live audio indicators need tighter ones.
    public static let freshFor = CaptureConfiguration.stallTimeout
    /// While the Pendant screen is shown it asks for a status every `DrainCoordinator.liveRefresh` (5 s), but replies
    /// can queue behind a long download, so a report is "now" there for a reply timeout past two 30 s asks.
    /// ponytail: kept from the old 30 s cadence; tighten once replies during downloads are timed on hardware.
    public static let onScreenFor: Duration = .seconds(75)

    /// The one rule for a fact the Pendant reports: current only from a connected Pendant within `freshFor`.
    public static func isCurrent(_ observedAt: Date, connected: Bool, now: Date) -> Bool {
        connected && Self(observedAt: observedAt, now: now) == .fresh
    }

    /// The first moment evidence observed at `observedAt` is no longer fresh.
    public static func currentUntil(_ observedAt: Date) -> Date {
        observedAt.addingTimeInterval(Double(freshFor.components.seconds) + 1)
    }

    public init(observedAt: Date?, now: Date, freshFor: Duration = Self.freshFor) {
        guard let observedAt else {
            self = .unknown
            return
        }
        let age = now.timeIntervalSince(observedAt)
        self = age <= Double(freshFor.components.seconds) ? .fresh : .stale
    }
}
