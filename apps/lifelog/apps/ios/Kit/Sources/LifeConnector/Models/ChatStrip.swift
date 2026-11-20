import Foundation
import Library

// A draft card's chat strip (decision 82): the chat's head, its last messages as Life stamped them when the card was
// asked, then the draft. Kit decides what each line is; the app only draws it in its platform's look. What a draft
// does (a reply, a reaction, mentions, a file) comes from the draft's own fields, which Life refused when its chat
// can't take them: never from a list of networks.

extension Check {
    /// A draft card's chat as the card heads it (`draftHeadOf`): the network in words, the chat's name.
    public struct Head: Decodable, Sendable, Equatable {
        public let network: String
        public let name: String
    }
}

/// What a message's file is (`fileKindOf`, `memory/message-files.ts`).
public enum FileKind: String, UnknownTolerant, Sendable {
    case photo, video, audio, pdf, document
    case unknown
}

extension Check.Draft {
    /// One of the chat's last messages before the card was asked (`RecentMessage`, `memory/draft.ts`).
    public struct Recent: Decodable, Sendable, Equatable {
        public struct File: Decodable, Sendable, Equatable {
            public let kind: FileKind
            public let name: String
            /// Absent when the file is not on the Mac.
            public let size: Int?
        }
        public let at: Date
        public let sender: Party
        public let text: String?
        public let file: File?
    }

    /// One line of the strip above the draft: a message, or the message a reaction draft reacts to.
    public struct ChatLine: Sendable, Equatable {
        /// A group's sender over the first bubble of their run: their first name, and which sender colour it takes.
        public struct Sender: Sendable, Equatable {
            public let name: String
            public let tone: Int
        }
        public let text: String?
        public let file: Recent.File?
        public let isMine: Bool
        public let sender: Sender?
        /// The day it opens, only when it is not the day of the line before.
        public let newDay: Date?
        /// The drafted reaction, on the message it reacts to.
        public let reaction: String?
    }

    /// A stretch of the draft's words: a mention it names (`@Name`) is drawn the platform's way, never as plain text.
    public struct TextRun: Sendable, Equatable {
        public let text: String
        public let isMention: Bool
    }

    /// A mail draft (it names his address); a chat's never does.
    public var isMail: Bool { from != nil }

    /// The strip's lines, oldest first. A reaction sits on its message when exactly one of the last messages holds the
    /// quoted words (`quotedIndex`), else on the quoted message drawn last. A group's sender names show when two or more
    /// people besides him wrote. ponytail: recent messages carry no id and the wire no `members`: a group where one
    /// person wrote lately shows no names, and twin messages ("OK", "OK") take the quoted one drawn apart.
    public func chatLines(calendar: Calendar) -> [ChatLine] {
        typealias Message = (text: String?, file: Recent.File?, isMine: Bool, who: String, name: String, at: Date?)
        var messages: [Message] = (recent ?? []).map {
            ($0.text, $0.file, $0.sender.isOwner, $0.sender.ref, $0.sender.name, $0.at)
        }
        var reactsTo: Int?
        if reaction != nil, let quoted {
            reactsTo = quotedIndex
            if reactsTo == nil {
                messages.append((quoted.text, nil, false, quoted.sender, quotedSender ?? quoted.sender, nil))
                reactsTo = messages.count - 1
            }
        }
        var others: [String] = []
        for message in messages where !message.isMine && !others.contains(message.who) { others.append(message.who) }
        return messages.indices.map { i in
            let message = messages[i]
            let before = i > 0 ? messages[i - 1] : nil
            let newDay = message.at.flatMap { at in
                before?.at.flatMap { calendar.isDate($0, inSameDayAs: at) ? nil : calendar.startOfDay(for: at) }
            }
            let opensRun = before?.who != message.who || newDay != nil
            let sender =
                others.count > 1 && !message.isMine && opensRun
                ? ChatLine.Sender(
                    name: message.name.split(separator: " ").first.map(String.init) ?? message.name,
                    tone: others.firstIndex(of: message.who) ?? 0)
                : nil
            return ChatLine(
                text: message.text, file: message.file, isMine: message.isMine, sender: sender, newDay: newDay,
                reaction: i == reactsTo ? reaction : nil)
        }
    }

    /// Which of the last messages the draft replies or reacts to: the one whose words open with the quoted ones, when
    /// exactly one does.
    public var quotedIndex: Int? {
        guard let quoted, let recent else { return nil }
        let found = recent.indices.filter { recent[$0].text?.hasPrefix(quoted.text) ?? false }
        return found.count == 1 ? found[0] : nil
    }

    /// Who wrote the quoted message, by the name Life gives them; nil when it is not among the last messages (the
    /// quote then names its sender as the network did).
    public var quotedSender: String? { quotedIndex.flatMap { recent?[$0].sender.name } }

    /// The draft's words cut at each mention it names, in their order (`mentionsAt`, `memory/draft.ts`).
    public var textRuns: [TextRun] {
        guard let text else { return [] }
        var runs: [TextRun] = []
        var from = text.startIndex
        for mention in mentions ?? [] {
            guard let at = text.range(of: "@" + mention.name, range: from..<text.endIndex) else { continue }
            if from < at.lowerBound { runs.append(TextRun(text: String(text[from..<at.lowerBound]), isMention: false)) }
            runs.append(TextRun(text: String(text[at]), isMention: true))
            from = at.upperBound
        }
        if from < text.endIndex { runs.append(TextRun(text: String(text[from...]), isMention: false)) }
        return runs
    }
}

extension Check.Draft.File {
    /// A photo shows as a picture, any other file as its name and size.
    public var isPhoto: Bool { mime?.hasPrefix("image/") ?? false }
}

/// Where a draft he sent stands, as its bubble shows it in place of "Not sent": the send's own steps (`sendStepsOf`):
/// `handed`, one tick; `confirmed` (Life saw it in the chat) or Life's answer that it was sent, two. Never "delivered":
/// no source reports the other side's receipt.
public enum DraftDelivery: Sendable, Equatable {
    case notSent, handed, sent

    public init<Proof>(_ state: ActionState<Proof>) {
        let passed = state.steps.filter { $0.passedAt != nil }.map(\.id)
        if case .succeeded = state {
            self = .sent
        } else {
            self = passed.contains("confirmed") ? .sent : passed.contains("handed") ? .handed : .notSent
        }
    }
}
