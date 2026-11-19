import Foundation

/// A sentence's who-and-when in his words, the one wording for every ask body: "Camille, WhatsApp, Sat 14 Nov".
public enum SaidWords {
    /// "Sat 14 Nov".
    public static func day(_ date: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        date.formatted(Date.FormatStyle(locale: locale, timeZone: timeZone).weekday(.abbreviated).day().month(.abbreviated))
    }

    /// "Tue 17 Nov, 09:14".
    public static func moment(_ date: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        day(date, locale: locale, timeZone: timeZone) + ", "
            + date.formatted(Date.FormatStyle(locale: locale, timeZone: timeZone).hour().minute())
    }

    /// An instant (`2026-11-14T10:00:00Z`) or a day (`2026-11-14`) as Life writes `at`.
    static func parse(_ at: String, timeZone: TimeZone) -> (date: Date, isDay: Bool)? {
        if at.count == 10 {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            let parts = at.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3,
                let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
            else { return nil }
            return (date, true)
        }
        for options: ISO8601DateFormatter.Options in [
            [.withInternetDateTime, .withFractionalSeconds], [.withInternetDateTime],
        ] {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = options
            if let date = formatter.date(from: at) { return (date, false) }
        }
        return nil
    }
}

extension Check.Said {
    /// Who to whom, where and when, as it reads above the words: the speaker, "to <chat>" when the chat is not the speaker's
    /// own name, the channel, the day. A part Life does not know is left out.
    public func line(
        channelName: (String) -> String = { $0 }, locale: Locale = .current, timeZone: TimeZone = .current
    ) -> String {
        let when = at.flatMap { SaidWords.parse($0, timeZone: timeZone) }
            .map { SaidWords.day($0.date, locale: locale, timeZone: timeZone) }
        let toWhom = to.flatMap { $0 == by ? nil : "to \($0)" }
        return [by, toWhom, channel.map(channelName), when].compactMap(\.self).joined(separator: ", ")
    }
}

extension Check {
    /// A guessed person's name as the question says it ("Is this Kit?" gives "Kit"), for the link "Why Kit?"; nil for any other wording.
    public var personCalled: String? {
        guard group == .guessedPerson, question.hasPrefix("Is this "), question.hasSuffix("?") else { return nil }
        return String(question.dropFirst("Is this ".count).dropLast())
    }
}

extension Check.Person {
    /// Up to two capitals: "Marc Delmas" gives "MD".
    public var initials: String { String(name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased() }
}
