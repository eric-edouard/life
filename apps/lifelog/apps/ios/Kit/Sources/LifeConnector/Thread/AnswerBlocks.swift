import Foundation

/// One of Life's components in an answer: a fenced block, ```` ```life:<kind> ````, around its JSON
/// (`records/answer-blocks.ts`, the one catalog). The server checks every block before the phone sees it; this reads the
/// shapes it draws and drops any other: an unknown kind, a kind newer than `catalog`, bad JSON. Nothing in a block acts
/// but Life's own items.
public enum LifeBlock: Equatable, Sendable {
    public struct Document: Equatable, Sendable {
        public let from, kind, title: String
        public let lines: [String]
        public let total: String?
    }
    public struct Phrase: Equatable, Sendable {
        public let lang, mine, text: String
        public let to: String?
    }
    public struct Place: Equatable, Sendable {
        public let address, name: String
    }
    public struct Question: Equatable, Sendable {
        public let answers: [String]
        public let recommended: String?
    }
    public struct Table: Equatable, Sendable {
        public let columns: [String]
        public let rows: [[String]]
        public let total: String?
    }
    case document(Document)
    case items([String])
    case phrase(Phrase)
    case pictures([String])
    case place(Place)
    case question(Question)
    case settings(keys: [String]?)
    case table(Table)

    /// The version of Life's blocks this phone draws, sent with every ask.
    public static let catalog = 1

    public init?(kind: String, json: Data) {
        guard let body = try? JSONSerialization.jsonObject(with: json, options: .fragmentsAllowed) else { return nil }
        let o = body as? [String: Any] ?? [:]
        func string(_ key: String) -> String? { (o[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        func strings(_ value: Any?) -> [String]? { (value as? [Any])?.compactMap { $0 as? String } }
        switch kind {
        case "items": self = .items(strings(body) ?? [])
        case "pictures": self = .pictures(strings(body) ?? [])
        case "settings": self = .settings(keys: strings(o["keys"]))
        case "place":
            guard let name = string("name"), let address = string("address") else { return nil }
            self = .place(Place(address: address, name: name))
        case "phrase":
            guard let lang = string("lang"), let mine = string("mine"), let text = string("text") else { return nil }
            self = .phrase(Phrase(lang: lang, mine: mine, text: text, to: string("to")))
        case "question":
            guard let answers = strings(o["answers"]), answers.count >= 2 else { return nil }
            self = .question(Question(answers: answers, recommended: string("recommended")))
        case "table":
            guard let columns = strings(o["columns"]), let rows = o["rows"] as? [[Any]] else { return nil }
            self = .table(Table(columns: columns, rows: rows.map { $0.map(Self.cell) }, total: (o["total"]).map(Self.cell)))
        case "document":
            guard let from = string("from"), let kind = string("kind"), let title = string("title"),
                let lines = o["lines"] as? [Any]
            else { return nil }
            self = .document(
                Document(from: from, kind: kind, title: title, lines: lines.map(Self.cell), total: o["total"].map(Self.cell)))
        default: return nil
        }
        if case .items(let refs) = self, refs.isEmpty { return nil }
        if case .pictures(let refs) = self, refs.isEmpty { return nil }
    }

    /// A cell as it reads: a number without a needless ".0".
    private static func cell(_ value: Any) -> String {
        if let n = value as? NSNumber, !(value is String) {
            return n.doubleValue == n.doubleValue.rounded() ? String(n.intValue) : String(n.doubleValue)
        }
        return value as? String ?? ""
    }
}

/// A stretch of an answer: Markdown, or one of Life's blocks.
public enum AnswerPart: Equatable, Sendable {
    case markdown(String)
    case block(LifeBlock)

    /// An answer's parts in order. A fence of any indent, with ``` or ~~~, whose first word is `life:<kind>`, is a block
    /// (shown when it reads, dropped when it does not), never Markdown.
    public static func parts(of text: String) -> [AnswerPart] {
        var parts: [AnswerPart] = []
        var prose: [Substring] = []
        func flush() {
            let joined = prose.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty { parts.append(.markdown(joined)) }
            prose = []
        }
        var lines = text.split(separator: "\n", omittingEmptySubsequences: false)[...]
        while let line = lines.popFirst() {
            let t = line.drop { $0 == " " || $0 == "\t" }
            guard let fence = t.first, fence == "`" || fence == "~" else { prose.append(line); continue }
            let ticks = t.prefix { $0 == fence }
            let info = t.dropFirst(ticks.count).trimmingCharacters(in: .whitespaces)
            guard ticks.count >= 3, info.hasPrefix("life:") else { prose.append(line); continue }
            let kind = String(info.dropFirst(5).prefix { !$0.isWhitespace })
            var body: [Substring] = []
            while let next = lines.popFirst() {
                let n = next.drop { $0 == " " || $0 == "\t" }
                if n.prefix(while: { $0 == fence }).count >= ticks.count, n.drop(while: { $0 == fence }).allSatisfy(\.isWhitespace) {
                    break
                }
                body.append(next)
            }
            flush()
            if let block = LifeBlock(kind: kind, json: Data(body.joined(separator: "\n").utf8)) { parts.append(.block(block)) }
        }
        flush()
        return parts
    }
}
