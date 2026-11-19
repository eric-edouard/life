import Foundation

/// A deadline in his words, the one wording for every screen that shows one: an ask's line above its answers, a
/// matter's row, the asks list.
public enum DeadlineWords {
    /// "Thu 18:00" (the clock as his region writes it).
    public static func when(_ deadline: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        deadline.formatted(Date.FormatStyle(locale: locale, timeZone: timeZone).weekday(.abbreviated).hour().minute())
    }

    /// A matter's row: "By Thu 18:00".
    public static func by(_ deadline: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        "By " + when(deadline, locale: locale, timeZone: timeZone)
    }
}

extension Check {
    /// The one line above an ask's answers: "Answer by Thu 18:00", or, when the agent goes on by itself with one of the
    /// answers, "After Thu 18:00 it goes with <that answer>". Nil without a deadline. A draft never goes by itself.
    public func deadlineLine(locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        guard let deadline else { return nil }
        let when = DeadlineWords.when(deadline, locale: locale, timeZone: timeZone)
        guard draft == nil, let chosen = options.first(where: { $0.id == onSilence }) else {
            return "Answer by \(when)"
        }
        return "After \(when) it goes with \(chosen.label)"
    }
}
