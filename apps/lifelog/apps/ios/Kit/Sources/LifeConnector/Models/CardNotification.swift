import Foundation
import Library

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
