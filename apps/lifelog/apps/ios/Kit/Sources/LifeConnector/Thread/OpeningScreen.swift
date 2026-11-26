import Foundation

/// The opening screen (the app v4 prototype, his yes of 26 Nov 2026). At launch, or back after `cleanAfter` or more in the
/// background, the thread opens clean: his greeting, what is broken (never capped), then at most `cap` asks that block
/// him (Life's `openingAsks`, in his inbox's order) and a pill for the rest; his badge counts those and what is broken (`ThreadRead.blocking`). What came
/// before is one Show earlier away, a day at a time, and an earlier opening's greeting stays only as its time. Back
/// sooner, nothing changes. Held for the launch only, never stored.
public struct OpeningScreen: Equatable, Sendable {
    public static let cleanAfter: TimeInterval = 5 * 60
    public static let cap = 3

    /// When the screen last opened clean: the greeting's time. Nil until the first opening.
    public private(set) var at: Date?
    /// This launch's earlier openings, oldest first: their greetings, kept only as their time.
    public private(set) var earlierGreetings: [Date] = []
    /// From when the thread shows; Show earlier moves it back a day at a time.
    public private(set) var shownFrom: Date?
    /// The rows of this opening, as refs: they keep their place while he answers them (each row shows its own state).
    public private(set) var broken: [String] = []
    public private(set) var top: [String] = []
    public private(set) var more: [String] = []
    private var hasRows = false
    private var leftAt: Date?

    public init() {}

    /// The app went to the background.
    public mutating func left(at now: Date) { leftAt = now }

    /// The app is in front again: true when the screen opened clean (the first time, or after `cleanAfter` away).
    @discardableResult
    public mutating func came(at now: Date) -> Bool {
        defer { leftAt = nil }
        if at != nil, leftAt.map({ now.timeIntervalSince($0) < Self.cleanAfter }) ?? true { return false }
        if let at { earlierGreetings.append(at) }
        (at, shownFrom, hasRows) = (now, now, false)
        (broken, top, more) = ([], [], [])
        return true
    }

    /// Takes a read of the thread: the first after an opening sets its rows; a later one only adds what broke since, so
    /// a fix shows at once and nothing he is answering moves.
    public mutating func take(_ read: ThreadRead) {
        let fixes = read.broken.map(\.ref)
        guard hasRows else {
            let asks = read.openingAsks.filter { read.ask($0)?.isAnswerable == true }
            (broken, top, more) = (fixes, Array(asks.prefix(Self.cap)), Array(asks.dropFirst(Self.cap)))
            hasRows = true
            return
        }
        broken += fixes.filter { !broken.contains($0) }
    }

    public func isShown(_ date: Date) -> Bool { shownFrom.map { !(date < $0) } ?? true }

    /// The start of the latest day before what is shown that holds any of `dates`; nil: nothing earlier.
    public func earlierDay(of dates: [Date], calendar: Calendar) -> Date? {
        dates.filter { !isShown($0) }.max().map { calendar.startOfDay(for: $0) }
    }

    /// Show earlier: one more day of `dates` shows.
    public mutating func showEarlier(of dates: [Date], calendar: Calendar) {
        if let day = earlierDay(of: dates, calendar: calendar) { shownFrom = day }
    }
}
