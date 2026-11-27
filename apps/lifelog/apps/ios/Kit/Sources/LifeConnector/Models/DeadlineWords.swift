import Foundation

/// A deadline in his words, the one wording for every screen that shows one: an ask's line above its answers, a
/// matter's row, the asks list.
public enum DeadlineWords {
    /// "Thu 18:00" (the clock as his region writes it).
    public static func when(_ deadline: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        deadline.formatted(Date.FormatStyle(locale: locale, timeZone: timeZone).weekday(.abbreviated).hour().minute())
    }

    /// What VoiceOver reads for a deadline shown as "Thu 18:00": "Answer by Thursday 18:00".
    public static func spoken(_ deadline: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        "Answer by "
            + deadline.formatted(Date.FormatStyle(locale: locale, timeZone: timeZone).weekday(.wide).hour().minute())
    }

    /// A matter's row: "By Thu 18:00".
    public static func by(_ deadline: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        "By " + when(deadline, locale: locale, timeZone: timeZone)
    }
}

extension Check {
    /// The one line above an ask's answers: "Answer by Thu 18:00", or, when the agent goes on by itself with one of the
    /// answers, "After Thu 18:00 it goes ahead" (it is the filled one) or "it goes with <that answer>". Nil without a deadline. A draft never goes by itself.
    public func deadlineLine(locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        guard let deadline else { return nil }
        let when = DeadlineWords.when(deadline, locale: locale, timeZone: timeZone)
        guard draft == nil, let chosen = options.first(where: { $0.id == onSilence }) else {
            return "Answer by \(when)"
        }
        return "After \(when) it goes " + (chosen.id == filled?.id ? "ahead" : "with \(chosen.label)")
    }
}

extension DeadlineWords {
    /// A row's day, the prototype's `when`: "today" (or "tonight", when it is still to come and after 17:00), "tomorrow",
    /// the weekday within the week ahead, else "3 Dec".
    public static func day(_ date: Date, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String
    {
        let days =
            calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day
            ?? 0
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        return switch days {
        case 0: date > now && calendar.component(.hour, from: date) >= 17 ? "tonight" : "today"
        case 1: "tomorrow"
        case 2...6: date.formatted(style.weekday(.abbreviated))
        default: date.formatted(style.day().month(.abbreviated))
        }
    }
}

extension Check {
    /// His own step to do, the prototype's `task` (a matter's step that is his, a payment he makes): the only rows
    /// that put themselves off with a Later pill.
    public var isTask: Bool {
        group == .yourMove || options.contains { $0.looks == true }
            || needs?.contains { [.amount, .account, .qr].contains($0.kind) } == true
    }

    /// The network a sign-in fix names (`fix:signed-out/<network>`, `fix:not-linked/<network>`, `memory/fix-checks.ts`):
    /// its row shows that network's mark.
    public var signInNetwork: String? {
        ["fix:signed-out/", "fix:not-linked/"].first { ref.hasPrefix($0) }.map { String(ref.dropFirst($0.count)) }
    }

    /// Who an ask of his list is about, under its title (the prototype's `sub`): the chat or network it comes
    /// through, else "A voice, Sat 14 Nov", else the matter it serves when the title is not already that matter.
    public func rowWho(locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        let chat = [networkIdentity?.shownName ?? draft?.to, networkIdentity?.network ?? draft?.channel]
            .compactMap { $0 }.joined(separator: ", ")
        if !chat.isEmpty { return chat }
        if group == .voice, let at {
            let day = Date.FormatStyle(locale: locale, timeZone: timeZone).weekday(.abbreviated).day().month(
                .abbreviated)
            return "A voice, " + at.formatted(day)
        }
        return (matter ?? onMatters?.first).map(\.name).flatMap { $0 == title ? nil : $0 }
    }
}
