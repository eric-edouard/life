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

    /// One line of the strip above the draft: one of the chat's last messages.
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
    }

    /// A stretch of the draft's words: a mention it names (`@Name`) is drawn the platform's way, never as plain text.
    public struct TextRun: Sendable, Equatable {
        public let text: String
        public let isMention: Bool
    }

    /// A mail draft (it names his address); a chat's never does.
    public var isMail: Bool { from != nil }

    /// The last messages as the strip's lines, oldest first, each where it was: a reply's or a reaction's message is
    /// never placed among them, since nothing on the wire proves which one it is (no ids on `recent`); it shows apart,
    /// as Life stamped it (`quoted`). A group's sender names show when two or more people besides him wrote.
    /// ponytail: the wire has no `members`, so a group where one person wrote lately shows no names.
    public func chatLines(calendar: Calendar) -> [ChatLine] {
        let messages = recent ?? []
        var others: [String] = []
        for message in messages where !message.sender.isOwner && !others.contains(message.sender.ref) {
            others.append(message.sender.ref)
        }
        return messages.indices.map { i in
            let message = messages[i]
            let before = i > 0 ? messages[i - 1] : nil
            let newDay =
                before.map { calendar.isDate($0.at, inSameDayAs: message.at) } == false
                ? calendar.startOfDay(for: message.at) : nil
            let opensRun = before?.sender.ref != message.sender.ref || newDay != nil
            let name = message.sender.name
            let sender =
                others.count > 1 && !message.sender.isOwner && opensRun
                ? ChatLine.Sender(
                    name: name.split(separator: " ").first.map(String.init) ?? name,
                    tone: others.firstIndex(of: message.sender.ref) ?? 0)
                : nil
            return ChatLine(
                text: message.text, file: message.file, isMine: message.sender.isOwner, sender: sender,
                newDay: newDay)
        }
    }

    /// The draft's words cut at each mention it names, found as the send finds them (`mentionsAt`,
    /// `sources/matrix-content.ts`): in order, each after the one before, code unit for code unit as JavaScript's `indexOf`
    /// (`.literal`: a decomposed `é` is not `é`), a name only whole (`@Ann` isn't in `@Anna`); a mention not found ends
    /// the search.
    public var textRuns: [TextRun] {
        guard let text else { return [] }
        var runs: [TextRun] = []
        var from = text.startIndex
        mentions: for mention in mentions ?? [] {
            var at = text.range(of: "@" + mention.name, options: .literal, range: from..<text.endIndex)
            while let found = at, text.utf16.isWordUnit(at: found.upperBound) {
                let after = text.index(after: found.lowerBound)
                at = text.range(of: "@" + mention.name, options: .literal, range: after..<text.endIndex)
            }
            guard let at else { break mentions }
            if from < at.lowerBound { runs.append(TextRun(text: String(text[from..<at.lowerBound]), isMention: false)) }
            runs.append(TextRun(text: String(text[at]), isMention: true))
            from = at.upperBound
        }
        if from < text.endIndex { runs.append(TextRun(text: String(text[from...]), isMention: false)) }
        return runs
    }
}

extension String.UTF16View {
    /// Whether the code unit at `index` is a letter, a number or `_`, as the send's `WORD_CHAR` tests the one UTF-16 unit
    /// after a name: half of a pair (a letter beyond the BMP) is none, so `@Ann𠮷` holds a whole `@Ann`.
    fileprivate func isWordUnit(at index: String.Index) -> Bool {
        guard index < endIndex, let scalar = Unicode.Scalar(self[index]) else { return false }
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber,
            .letterNumber, .otherNumber:
            return true
        default: return scalar == "_"
        }
    }
}

extension Check {
    /// A mail draft as its card shows it: the thread's message it answers on one line, then every field the send uses.
    public struct MailSheet: Sendable, Equatable {
        public struct Thread: Sendable, Equatable {
            public let sender: String
            /// When it was written; nil from a card asked before `recent`, which has only the stamped quote.
            public let at: Date?
            public let text: String
        }
        public struct Field: Sendable, Equatable {
            public let label: String
            public let value: String
            public let isBold: Bool
        }
        public let thread: Thread?
        public let fields: [Field]
    }

    /// Its mail sheet; nil for a chat's draft. The thread's line is `recent`'s, else the stamped quote; `To` keeps the
    /// "~" of a recipient Life only guesses; `Cc` shows only when set.
    public var mailSheet: MailSheet? {
        guard let draft, draft.isMail else { return nil }
        let thread =
            draft.recent?.last.map { MailSheet.Thread(sender: $0.sender.name, at: $0.at, text: $0.text ?? "") }
            ?? draft.quoted.map { MailSheet.Thread(sender: $0.sender, at: nil, text: $0.text) }
        let fields: [(String, String?, Bool)] = [
            ("From", draft.from, false), ("To", (isRecipientGuessed ? "~ " : "") + draft.to, false),
            ("Cc", draft.cc, false), ("Subject", draft.subject, true),
        ]
        return MailSheet(
            thread: thread,
            fields: fields.compactMap { label, value, isBold in
                value.map { MailSheet.Field(label: label, value: $0, isBold: isBold) }
            })
    }
}

extension Check.Draft.File {
    /// A photo shows as a picture, any other file as its name and size.
    public var isPhoto: Bool { mime?.hasPrefix("image/") ?? false }
}

/// Where a draft he sent stands, as its bubble shows it in place of "Not sent", from proof only: while it runs, the
/// send's own steps (`sendStepsOf`), `handed` one tick and `confirmed` (Life saw it in the chat) two; once it ended,
/// Life's answer (`send.state`): sent, two; an answer that sent nothing (`send` absent), none; a call that never gave
/// its answer, may have gone, unless `confirmed` had already come: then it is sent. Never "delivered": no source reports
/// the other side's receipt.
public enum DraftDelivery: Sendable, Equatable {
    case notSent, handed, sent, mayHaveGone

    public init(_ state: ActionState<ActionProof>) {
        let passed = state.steps.filter { $0.passedAt != nil }.map(\.id)
        switch state {
        case .succeeded(let proof, _): self = proof.isSent ? .sent : .notSent
        case .failed(let failure, _):
            self =
                passed.contains("confirmed")
                ? .sent : failure.mayHaveHappened || failure.isSameTap ? .mayHaveGone : .notSent
        case .idle, .running:
            self = passed.contains("confirmed") ? .sent : passed.contains("handed") ? .handed : .notSent
        }
    }
}

extension DraftDelivery {
    /// A send that ended, in one word for its result screen and its notification: the bubble's, so they never differ.
    public var word: String {
        switch self {
        case .sent: "Sent."
        case .mayHaveGone: "May have gone."
        case .notSent, .handed: "Not sent."
        }
    }
}

extension ActionState where Proof == ActionProof {
    /// Whether his tap is over: Life answered, or the draft he sent (`isSend`) was seen in its chat
    /// (`DraftDelivery.sent`) and only Life's answer was lost. The card then moves on, offering nothing again.
    public func isDone(isSend: Bool) -> Bool {
        switch self {
        case .succeeded: true
        case .failed: isSend && DraftDelivery(self) == .sent
        case .idle, .running: false
        }
    }

    /// Whether the result offers his tap again (Try again): Life allows it, nothing may have happened, and it is not done.
    public func offersRetry(isSend: Bool) -> Bool {
        guard case .failed(let failure, _) = self else { return false }
        return failure.canTryAgain && !isDone(isSend: isSend)
    }
}

extension ActionProof {
    /// Life's answer says the draft was sent.
    public var isSent: Bool {
        if case .answered(let result) = self { return result.send?.state == .sent }
        return false
    }
}
