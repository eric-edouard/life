import Foundation
import Library
import UserNotifications

/// A card's notification, written on the phone from the card Life sent (`read_inbox`): Life's own words, clipped (a
/// draft never: what he sends is what he read), never words of the phone's. The push carried none (`host/card-push.ts`): only the card's `pushId`.
public struct CardNotification: Sendable, Equatable {
    /// The card's `title`.
    public let title: String
    /// Who asks, and the matter it belongs to.
    public let subtitle: String
    /// To whom and the draft's words, whole, or the card's `question`.
    public let body: String
    /// The notifications of one matter stack together; the rest in Life's thread.
    public let thread: String
    /// The card as Life sent it (JSON), kept with the notification for its expanded view and its answer.
    public let card: String
    /// `sendCategory` for a card it can send from (Send on the Watch too), else `category`.
    public let category: String

    static let titleLimit = 40
    static let subtitleLimit = 40
    static let bodyLimit = 110

    /// The card `pushId` names in a `read_inbox` reply, as its notification; nil when it is not open (or unreadable).
    /// `asksFaceID`: his setting that Send waits for Face ID, which only the phone can ask, so the Watch gets no Send.
    public static func of(pushId: String, inbox: String, asksFaceID: Bool) -> CardNotification? {
        found(pushId: pushId, in: inbox).map { of($0.check, card: $0.card, asksFaceID: asksFaceID) }
    }

    /// The card `pushId` names in a `read_inbox` reply, with its JSON as Life sent it.
    private static func found(pushId: String, in inbox: String) -> (check: Check, card: String)? {
        guard
            let read = try? JSONSerialization.jsonObject(with: Data(inbox.utf8)) as? [String: Any],
            let found = (read["checks"] as? [[String: Any]])?.first(where: { $0["pushId"] as? String == pushId }),
            let data = try? JSONSerialization.data(withJSONObject: found),
            let check = try? LibraryStore.feedDecoder.decode(Check.self, from: data)
        else { return nil }
        return (check, String(decoding: data, as: UTF8.self))
    }

    static func of(_ check: Check, card: String, asksFaceID: Bool) -> CardNotification {
        let who = check.agentName(runtime: nil) ?? "Life"
        return CardNotification(
            title: clipped(check.title, to: titleLimit),
            subtitle: clipped(check.matter.map { "\(who) · \($0.name)" } ?? who, to: subtitleLimit),
            body: check.draft.map(drafted) ?? clipped(check.question, to: bodyLimit),
            thread: check.matter?.id ?? "life-cards",
            card: card,
            category: sendOption(check) != nil && !asksFaceID ? sendCategory : category)
    }

    // MARK: Answering from the notification

    /// The category every card's push names (`alertOf`, lifelog's `apns.ts`).
    public static let category = "life.card"
    /// A card it can send from: its category's actions, which the Watch shows, are Send and Reply….
    public static let sendCategory = "life.card.send"
    /// The action that sends the card's draft.
    public static let send = "send"
    /// The action that answers in his own words, typed or dictated (a decision's, `Check.takesOwnWords`).
    public static let reply = "reply"
    private static let optionPrefix = "option:"
    /// Where the service extension keeps the card in its notification's `userInfo`.
    public static let userInfoKey = "card"
    /// Where it keeps the origin of the Life the card was read from.
    public static let lifeKey = "cardLife"

    /// The card kept with its notification (`userInfo[userInfoKey]`, written by the service extension).
    public static func card(in userInfo: [AnyHashable: Any]) -> Check? {
        (userInfo[userInfoKey] as? String).flatMap(check)
    }

    /// The card a notification kept, if it is this push's and was read from the Life the phone is paired with now
    /// (`life`, its `lifeKey`; `isOf`); nil otherwise, an older notification that names no Life included.
    public static func check(_ card: String?, pushId: String, life: String?, pairedWith paired: URL?) -> Check? {
        guard let card, isOf(life: life, pairedWith: paired), let check = check(card),
            check.pushId == pushId
        else { return nil }
        return check
    }

    /// Whether what was read from the Life at `life` (an origin, as a notification keeps it) is of the Life the phone is
    /// paired with now (`paired`): across processes and launches, a pairing is its Life's origin; within the app it is
    /// its `PairingGeneration`.
    public static func isOf(life: String?, pairedWith paired: URL?) -> Bool {
        life != nil && life == paired?.absoluteString
    }

    /// The card a notification names, as the Life paired now has it: the one it kept (`check(_:pushId:life:pairedWith:)`),
    /// else Life's own read of that card from that Life alone (`readPush`, `read_inbox` by its `pushId` at the origin it
    /// is given, which no limit cuts off; a pushId of another Life names nothing there). Nil when it is not open there.
    /// The one door to a notification's card: opening it, and every answer from it, Send included.
    public static func card(
        pushId: String, kept: String?, life: String?, pairedWith paired: URL?,
        readPush: @Sendable (URL) async throws -> String
    ) async -> Check? {
        if let check = check(kept, pushId: pushId, life: life, pairedWith: paired) { return check }
        guard let paired, let read = try? await readPush(paired) else { return nil }
        return found(pushId: pushId, in: read)?.check
    }

    /// The service extension's read of a push's card: from the Life paired when the push arrived (`paired`) and no other
    /// (`readPush` reads at the origin it is given), so the origin it keeps with the card (`lifeKey`) is the read's own.
    public static func read(
        pushId: String, pairedWith paired: URL?, asksFaceID: Bool, readPush: @Sendable (URL) async throws -> String
    ) async -> (card: CardNotification, life: URL)? {
        guard let paired, let inbox = try? await readPush(paired),
            let card = of(pushId: pushId, inbox: inbox, asksFaceID: asksFaceID)
        else { return nil }
        return (card, paired)
    }

    /// The card as kept (its JSON), if this build reads it.
    public static func check(_ card: String) -> Check? {
        try? LibraryStore.feedDecoder.decode(Check.self, from: Data(card.utf8))
    }

    /// The card's answers that take one tap, as its notification's buttons (action id, his button's words): its one-tap
    /// options and its Send. One that needs a person, a name or his words opens the card instead.
    public static func buttons(_ check: Check) -> [(id: String, label: String)] {
        check.options.compactMap {
            isOneTap($0) ? ("\(optionPrefix)\($0.id)", $0.label) : isSend($0, of: check) ? (send, $0.label) : nil
        }
    }

    /// Needs nothing more than the tap, and acts on nothing outward.
    /// A tap that is his word a step is done waits for Undo in the app: never a notification's button.
    private static func isOneTap(_ option: Check.Option) -> Bool {
        option.takes == nil && option.outgoing != true && option.ends == nil
    }

    /// Sends the card's draft, shown whole above it; never on a card that asks who its recipient is (`confirm`).
    private static func isSend(_ option: Check.Option, of check: Check) -> Bool {
        option.outgoing == true && option.takes == nil && check.draft != nil && !check.isRecipientGuessed
    }

    private static func sendOption(_ check: Check) -> Check.Option? { check.options.first { isSend($0, of: check) } }

    /// Whether a tapped action may go on to be answered: Send only once `prove` says so (Face ID or his passcode at
    /// that tap, when his setting asks for it); any other at once.
    public static func isAnswerAllowed(_ action: String, prove: @Sendable () async -> Bool) async -> Bool {
        guard action == send else { return true }
        return await prove()
    }

    /// The send category's Send (the Watch shows it), for the phone or Watch unlocked; the expanded view builds its own
    /// from `buttons`.
    public static var sendAction: UNNotificationAction {
        UNNotificationAction(identifier: send, title: "Send", options: [.authenticationRequired])
    }

    /// Reply…: his own words, typed or dictated. A category's button, so the Watch shows it.
    public static var replyAction: UNTextInputNotificationAction {
        UNTextInputNotificationAction(
            identifier: reply, title: "Reply…", options: [.authenticationRequired], textInputButtonTitle: "Send",
            textInputPlaceholder: "Your words")
    }

    /// The expanded notification's buttons: `buttons`, then Reply… when the card takes his own words. Every answer asks
    /// for the phone to be unlocked; Send also asks Face ID at the tap when his setting says so (`isAnswerAllowed`).
    public static func actions(_ check: Check) -> [UNNotificationAction] {
        buttons(check).map {
            UNNotificationAction(identifier: $0.id, title: $0.label, options: [.authenticationRequired])
        }
            + (check.takesOwnWords ? [replyAction] : [])
    }

    /// The answer a tapped action gives: one of `buttons`, or his words through `reply`; nil when the card can't be
    /// answered that way from its notification. A Send from the send category while he asks Face ID is refused: that
    /// notification came before the setting, and its Send (the Watch's) never asked.
    public static func answer(
        _ action: String, typed: String?, to check: Check, in category: String, asksFaceID: Bool
    ) -> AnswerRequest? {
        if action == reply {
            guard check.takesOwnWords, let typed, !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return nil
            }
            return check.answer(words: typed)
        }
        if action == send {
            return asksFaceID && category == sendCategory ? nil : sendOption(check).flatMap(check.answer)
        }
        guard let option = check.options.first(where: { "\(optionPrefix)\($0.id)" == action }), isOneTap(option)
        else { return nil }
        return check.answer(option)
    }

    /// Every part of the draft, one per line, as Life's nightly report writes it (`draftWords`): on the Watch it is all
    /// he sees before Send.
    private static func drafted(_ draft: Check.Draft) -> String {
        let to = "To \(draft.to)" + (draft.channel.map { " on \(Channel.name($0))" } ?? "")
        let reacts = draft.reaction.map { "Reaction \($0)" }
        return
            ([to + (draft.text.map { ": \"\($0)\"" } ?? "")]
            + [draft.file.map { "File \($0.name) (\($0.size.formatted(.byteCount(style: .file))))" }]
            + [
                draft.quoted.map { "\(reacts.map { "\($0) to" } ?? "Reply to") \($0.sender): \"\($0.text)\"" }
                    ?? reacts
            ]
            + [draft.mentions.flatMap { $0.isEmpty ? nil : "Mentions " + $0.map(\.name).joined(separator: ", ") }]
            + [draft.from.map { "From \($0)" }, draft.cc.map { "Cc \($0)" }, draft.subject.map { "Subject \($0)" }])
            .compactMap(\.self).joined(separator: "\n")
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
