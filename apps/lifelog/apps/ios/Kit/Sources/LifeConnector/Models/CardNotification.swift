import Foundation
import Library
import UserNotifications

/// A card's notification, written on the phone from the card Life sent (`read_inbox`): Life's own words, clipped, never
/// words of the phone's. The push carried none (`host/card-push.ts`): only the card's `pushId`.
public struct CardNotification: Sendable, Equatable {
    /// The card's `title`.
    public let title: String
    /// Who asks, and the matter it belongs to.
    public let subtitle: String
    /// To whom and the draft's words, or the card's `question`.
    public let body: String
    /// The notifications of one matter stack together; the rest in Life's thread.
    public let thread: String
    /// The card as Life sent it (JSON), kept with the notification for its expanded view and its answer.
    public let card: String

    static let titleLimit = 40
    static let subtitleLimit = 40
    static let bodyLimit = 110

    /// The card `pushId` names in a `read_inbox` reply, as its notification; nil when it is not open (or unreadable).
    public static func of(pushId: String, inbox: String) -> CardNotification? {
        guard
            let read = try? JSONSerialization.jsonObject(with: Data(inbox.utf8)) as? [String: Any],
            let found = (read["checks"] as? [[String: Any]])?.first(where: { $0["pushId"] as? String == pushId }),
            let data = try? JSONSerialization.data(withJSONObject: found),
            let check = try? LibraryStore.feedDecoder.decode(Check.self, from: data)
        else { return nil }
        return of(check, card: String(decoding: data, as: UTF8.self))
    }

    static func of(_ check: Check, card: String) -> CardNotification {
        let who = check.agentName(runtime: nil) ?? "Life"
        return CardNotification(
            title: clipped(check.title, to: titleLimit),
            subtitle: clipped(check.matter.map { "\(who) · \($0.name)" } ?? who, to: subtitleLimit),
            body: clipped(check.draft.map(drafted) ?? check.question, to: bodyLimit),
            thread: check.matter?.id ?? "life-cards",
            card: card)
    }

    // MARK: Answering from the notification

    /// The category every card's push names (`alertOf`, lifelog's `apns.ts`).
    public static let category = "life.card"
    /// The action that answers in his own words, typed or dictated (a decision's, `Check.takesOwnWords`).
    public static let reply = "reply"
    private static let optionPrefix = "option:"
    /// Where the service extension keeps the card in its notification's `userInfo`.
    public static let userInfoKey = "card"

    /// The card kept with its notification (`userInfo[userInfoKey]`, written by the service extension).
    public static func card(in userInfo: [AnyHashable: Any]) -> Check? {
        guard let text = userInfo[userInfoKey] as? String else { return nil }
        return try? LibraryStore.feedDecoder.decode(Check.self, from: Data(text.utf8))
    }

    /// The card's answers that take one tap, as its notification's buttons (action id, his button's words): its one-tap
    /// options and its Send. One that needs a person, a name or his words opens the card instead.
    public static func buttons(_ check: Check) -> [(id: String, label: String)] {
        check.options.filter { isOneTap($0) || isSend($0, of: check) }.map { (actionId($0), $0.label) }
    }

    /// Needs nothing more than the tap, and acts on nothing outward.
    private static func isOneTap(_ option: Check.Option) -> Bool { option.takes == nil && option.outgoing != true }

    /// Sends the card's draft, shown whole above it; never on a card that asks who its recipient is (`confirm`).
    private static func isSend(_ option: Check.Option, of check: Check) -> Bool {
        option.outgoing == true && option.takes == nil && check.draft != nil && (check.confirm ?? []).isEmpty
    }

    private static func actionId(_ option: Check.Option) -> String { "\(optionPrefix)\(option.id)" }

    private static func option(_ action: String, in check: Check) -> Check.Option? {
        check.options.first { actionId($0) == action }
    }

    /// Whether a tapped action may go on to be answered: one that acts outward only once `prove` (Face ID or his
    /// passcode, asked at that tap, every time) says so; any other at once.
    public static func mayAnswer(
        _ action: String, of check: Check, prove: @Sendable () async -> Bool
    ) async -> Bool {
        guard option(action, in: check)?.outgoing == true else { return true }
        return await prove()
    }

    /// Reply…: his own words, typed or dictated. The category's one button, so the Watch shows it.
    public static var replyAction: UNTextInputNotificationAction {
        UNTextInputNotificationAction(
            identifier: reply, title: "Reply…", options: [.authenticationRequired], textInputButtonTitle: "Send",
            textInputPlaceholder: "Your words")
    }

    /// The expanded notification's buttons: `buttons`, then Reply… when the card takes his own words. Every answer asks
    /// for the phone to be unlocked; Send also asks Face ID at the tap (`mayAnswer`, in the content extension).
    public static func actions(_ check: Check) -> [UNNotificationAction] {
        buttons(check).map {
            UNNotificationAction(identifier: $0.id, title: $0.label, options: [.authenticationRequired])
        }
            + (check.takesOwnWords ? [replyAction] : [])
    }

    /// The answer a tapped action gives: one of `buttons`, or his words through `reply`; nil when the card can't be
    /// answered that way from its notification.
    public static func answer(_ action: String, typed: String?, to check: Check) -> AnswerRequest? {
        if action == reply {
            guard check.takesOwnWords, let typed, !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return nil
            }
            return check.answer(words: typed)
        }
        guard let option = option(action, in: check), isOneTap(option) || isSend(option, of: check) else { return nil }
        return check.answer(option)
    }

    private static func drafted(_ draft: Check.Draft) -> String {
        let what = draft.text.map { "\"\($0)\"" } ?? draft.reaction ?? draft.file?.name ?? ""
        return "To \(draft.to): \(what)"
    }

    /// `text` on one line, cut at a word to at most `limit` characters with "…".
    static func clipped(_ text: String, to limit: Int) -> String {
        let line = text.split(whereSeparator: \.isNewline).joined(separator: " ")
        guard line.count > limit else { return line }
        let head = line.prefix(limit - 1)
        let cut = head.lastIndex(of: " ").map { head[..<$0] } ?? head
        return "\(cut.trimmingCharacters(in: .whitespaces))…"
    }
}
