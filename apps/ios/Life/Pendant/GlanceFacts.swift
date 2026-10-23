import Capture
import Incidents
import Library
import PendantProtocol
import SourceStore
import SwiftUI
import Timeline

/// Everything the Lens cards show, each device fact already classified as current, last known or unknown.
struct GlanceFacts: Equatable {
    var connection: ConnectionState
    var battery: Fact<Int>
    var charging: Observed<ChargingState>?
    var storage: Fact<StorageState>
    var sync: SyncSummary
    var backlog: Fact<Backlog>
    var lastCaughtUp: Date?
    var lastSaved: Date?
    var phoneFreeBytes: Int64?
    var archiveBytes: Int64?
    var today: SavedToday?
    var spending: TranscriptionFacts.Spending?
    var isPaired: Bool
    var batteryLife = BatteryLife()

    var isConnected: Bool {
        if case .ready = connection { true } else { false }
    }
}

extension Fact where Value: Sendable {
    init(_ observed: Observed<Value>?, connected: Bool, now: Date) {
        guard let observed else {
            self = .unknown
            return
        }
        self =
            EvidenceFreshness.isCurrent(observed.at, connected: connected, now: now)
            ? .current(observed.value, at: observed.at) : .lastKnown(observed.value, at: observed.at)
    }
}

/// Battery and storage as the cards say them.
extension GlanceFacts {
    /// Charging counts only while the level is current.
    var isCharging: Bool { battery.currentValue != nil && charging?.value == .charging }

    /// Low as the iPhone draws it: at or below 20 %, never while charging.
    var batteryIsLow: Bool {
        !isCharging && battery.currentValue.map { $0 <= BatteryGlyph.lowAtOrBelow } ?? false
    }

    var batteryCaption: String {
        switch battery {
        case .current(let percent, _):
            isCharging ? "Charging" : batteryIsLow ? "Low · \(timeLeft(from: percent))" : timeLeft(from: percent)
        case .lastKnown(_, let at): "Last known · \(at.moment)"
        case .unknown: "Never reported"
        }
    }

    /// "14h if recording", "3d if paused", each from what the app has learned (`BatteryLife`).
    private func timeLeft(from percent: Int) -> String {
        let recording = batteryLife.timeLeft(recording: true, from: percent)
        let paused = batteryLife.timeLeft(recording: false, from: percent)
        guard recording != nil || paused != nil else { return "Time left: not enough data yet" }
        func line(_ left: Duration?, _ state: String) -> String {
            guard let left else { return "\(state.capitalized): not enough data yet" }
            let units: Set<Duration.UnitsFormatStyle.Unit> =
                left < .seconds(3_600) ? [.minutes] : left < .seconds(2 * 86_400) ? [.hours] : [.days]
            return "\(left.formatted(.units(allowed: units, width: .narrow))) if \(state)"
        }
        return line(recording, "recording") + "\n" + line(paused, "paused")
    }
}

/// Today's conversations as the server has grouped them so far, from the cache.
struct SavedToday: Equatable {
    var recorded: Duration
    var conversations: Int
    var transcribed: Duration

    static func load(from library: LibraryStore, now: Date = .now) async -> SavedToday? {
        let start = Calendar.current.startOfDay(for: now)
        guard
            let conversations = try? await library.conversations(
                overlapping: CaptureInstant(start)..<CaptureInstant(now)),
            let facts = try? await library.facts(of: conversations)
        else { return nil }
        func length(_ conversation: CachedConversation) -> Duration { .milliseconds(conversation.range.millis) }
        return SavedToday(
            recorded: conversations.map(length).reduce(.zero, +), conversations: conversations.count,
            transcribed: conversations.filter { facts[$0.id]?.hasWords == true }.map(length).reduce(.zero, +))
    }
}
