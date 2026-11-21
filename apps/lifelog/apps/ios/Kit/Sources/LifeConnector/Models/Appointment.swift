import Foundation
import Library
import UserNotifications

/// An appointment Life added to his calendar, as its event sheet shows it (`read_appointments`,
/// `memory/read-appointments.ts`): only one the calendar sync wrote, by its push's `pushId` or its own id.
public struct Appointment: Decodable, Sendable, Equatable, Identifiable, ParsedRead, NamesParties {
    /// The message it was read from, quoted on the sheet: its chat as `read_chats` takes it and its `msg:` ref.
    public struct Source: Decodable, Sendable, Equatable {
        public let at: Date?
        public let chat: String
        public let message: String
        public let sender: Party?
        public let text: String
    }

    public let appointment: String
    public let pushId: String
    public let title: String
    /// Instants, or days (`2026-11-21`) when `allDay`; the end exclusive.
    public let startsAt: String
    public let endsAt: String
    public let allDay: Bool
    public let `where`: String?
    /// A meeting link copied from the messages, https only.
    public let link: String?
    public let from: Source?
    public let matterId: String?
    public let addedAt: Date?
    /// When he removed it; nil while it is in his calendar.
    public let removedAt: Date?

    public var id: String { appointment }
    public var parties: [Party] { from?.sender.map { [$0] } ?? [] }
    public var isRemoved: Bool { removedAt != nil }

    /// When it starts: an instant (`Z` or an offset), or the start of its first day at UTC when `allDay`.
    public var start: Date? {
        allDay ? Self.day.date(from: startsAt) : Self.instant(startsAt)
    }

    private static func instant(_ text: String) -> Date? {
        // `Z` and offsets (`+01:00`) alike, with or without fractions; the other styles read an offset as UTC.
        let styles = [true, false].map {
            Date.ISO8601FormatStyle(timeZoneSeparator: .colon, includingFractionalSeconds: $0)
        }
        return styles.lazy.compactMap { try? Date(text, strategy: $0) }.first
    }

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .gmt
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// "Dinner with Camille, Fri 20:00", or "…, Fri" all day: the push's line and its row's.
    public func line(in zone: TimeZone = .current) -> String {
        guard let start else { return title }
        return "\(title), \(Self.format(start, allDay ? "EEE" : "EEE HH:mm", allDay ? .gmt : zone))"
    }

    /// "Fri 21 Nov, 20:00", or "All day, Fri 21 Nov": the sheet's When.
    public func when(in zone: TimeZone = .current) -> String {
        guard let start else { return startsAt }
        return allDay
            ? "All day, \(Self.format(start, "EEE d MMM", .gmt))" : Self.format(start, "EEE d MMM, HH:mm", zone)
    }

    /// In English, as every word of the app; a day of an all-day one is its own, read at UTC (`day`).
    private static func format(_ date: Date, _ pattern: String, _ zone: TimeZone) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone
        f.dateFormat = pattern
        return f.string(from: date)
    }

    /// Apple Calendar on its day (`calshow:`, seconds since 2001): Calendar opens no event by another app's id. An
    /// all-day one opens on its own day's midnight where the phone is, never UTC's (behind UTC that is the day before).
    public func calendarURL(in zone: TimeZone = .current) -> URL? {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = .gmt
        var local = utc
        local.timeZone = zone
        let opens =
            allDay ? start.flatMap { local.date(from: utc.dateComponents([.year, .month, .day], from: $0)) } : start
        return opens.flatMap { URL(string: "calshow:\(Int($0.timeIntervalSinceReferenceDate))") }
    }

    /// Apple Maps on its place, by name.
    public var mapsURL: URL? {
        guard let place = `where`, var parts = URLComponents(string: "https://maps.apple.com/") else { return nil }
        parts.queryItems = [URLQueryItem(name: "q", value: place)]
        return parts.url
    }
}

/// What `change_appointment` returns: removed, restored, or failed with Life's reason (then nothing changed).
public struct AppointmentChange: Decodable, Sendable, Equatable {
    public enum Result: String, UnknownTolerant, Sendable {
        case removed, restored, failed
        case unknown
    }

    public let result: Result
    public let reason: String?

    /// Life's answer to his Remove (`isOn` false) or Undo: done, or thrown with Life's reason, so an action fails on it.
    public static func checked(_ text: String, isOn: Bool) throws {
        let change = try? LibraryStore.feedDecoder.decode(Self.self, from: Data(text.utf8))
        guard change?.result == (isOn ? .restored : .removed) else {
            throw MCPError.failed(change?.reason ?? "Life did not say it was done.")
        }
    }
}

/// The notification of an appointment Life added (`calendar.added`, category `life.calendar`), its words written on the
/// phone from `read_appointments` (the push itself carries only Life's word and the `pushId`), and its two actions.
public enum CalendarNotification {
    public static let category = "life.calendar"
    /// Remove, in the background with no app open: his own act, like the sheet's.
    public static let remove = "remove"
    /// Open in Calendar: opens the app, which opens Calendar on its day.
    public static let openInCalendar = "openInCalendar"
    /// Where the service extension keeps the appointment's id in its notification's `userInfo`.
    public static let appointmentKey = "appointment"

    public static let added = "Added to your calendar"
    public static let removed = "Removed from your calendar"
    public static let notRemoved = (title: "Not removed", body: "Your Mac did not answer. Open Life to try again.")

    public static var actions: [UNNotificationAction] {
        [
            UNNotificationAction(
                identifier: remove, title: "Remove", options: [.destructive],
                icon: UNNotificationActionIcon(systemImageName: "calendar.badge.minus")),
            UNNotificationAction(
                identifier: openInCalendar, title: "Open in Calendar", options: [.foreground],
                icon: UNNotificationActionIcon(systemImageName: "calendar")),
        ]
    }

    /// The words after his Remove from the notification: removed, else not removed (nothing changed).
    public static func afterRemove(isRemoved: Bool, line: String) -> (title: String, body: String) {
        isRemoved ? (removed, line) : notRemoved
    }
}
