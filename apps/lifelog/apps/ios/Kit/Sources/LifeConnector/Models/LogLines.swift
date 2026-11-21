import Foundation
import Library

/// A log line's level (`LOG_LEVELS` in `core/log-line.ts`, checked by `ContractTests`).
public enum LogLevel: String, UnknownTolerant, Sendable {
    case info, warn, error
    case unknown

    /// The tag a line leads with.
    public var tag: String {
        switch self {
        case .info, .unknown: "INF"
        case .warn: "WRN"
        case .error: "ERR"
        }
    }
}

/// The part of Life a line is about: a category's first word (`PROCESSES` in `core/log-line.ts`, checked by
/// `ContractTests`), in the order the process menu lists them.
public enum LogProcess: String, CaseIterable, Sendable {
    case desk, mcp, model, source, decision, draft, card, memory, watch, archive

    /// What the phone calls it: the connector and the watcher by their names, never the wire's words.
    public var name: String {
        switch self {
        case .mcp: "Connector"
        case .watch: "Watcher"
        default: rawValue.capitalized
        }
    }
}

/// One line of Life's log as `read_log_lines` shows it: never anyone's words, ids masked.
public struct LogLine: Decodable, Sendable, Equatable, Hashable, Identifiable {
    /// A piece of the message: the template's words, or a value formatted on the Mac ("38 s", "3"), drawn apart.
    public enum Part: Decodable, Sendable, Equatable, Hashable {
        case text(String)
        case value(String)

        private enum Key: String, CodingKey { case text, value }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: Key.self)
            if let value = try container.decodeIfPresent(String.self, forKey: .value) {
                self = .value(value)
            } else {
                self = .text(try container.decodeIfPresent(String.self, forKey: .text) ?? "")
            }
        }
    }

    /// Its place in the log, so unique: passed as a cursor, it reads the lines before it.
    public let id: String
    public let at: Date
    public let level: LogLevel
    /// The part of Life, then what it is about: `["desk", "wake"]`.
    public let category: [String]
    /// The whole message, flat: what Copy takes.
    public let message: String
    public let parts: [Part]

    public init(id: String, at: Date, level: LogLevel, category: [String], message: String, parts: [Part]? = nil) {
        (self.id, self.at, self.level, self.category, self.message) = (id, at, level, category, message)
        self.parts = parts ?? [.text(message)]
    }

    /// The category as a row shows it, `desk·wake`: its first word by the phone's name for it, lowercased.
    public var categoryWords: String {
        let head = category.first.map { LogProcess(rawValue: $0)?.name.lowercased() ?? $0 }
        return ([head].compactMap(\.self) + category.dropFirst()).joined(separator: "·")
    }
}

/// A page of `read_log_lines`, newest first; `cursor` reads the lines before it, nil once none is left.
public struct LogPage: Decodable, Sendable, Equatable {
    public let lines: [LogLine]
    public let cursor: String?
    /// The log's end as this read found it (a read with no cursor): the next poll reads only what came after it.
    public let head: String?

    public init(lines: [LogLine], cursor: String?, head: String? = nil) {
        (self.lines, self.cursor, self.head) = (lines, cursor, head)
    }
}

/// `read_log_lines`' arguments.
public struct LogQuery: Encodable, Sendable, Equatable, Hashable {
    /// A page's `head`: only the lines written after it.
    public var after: String?
    public var cursor: String?
    public var limit: Int?
    /// Nil: every level; `.warn`: the problems.
    public var minLevel: LogLevel?
    public var process: LogProcess?

    public init(cursor: String? = nil, limit: Int? = 100, minLevel: LogLevel? = nil, process: LogProcess? = nil) {
        (self.cursor, self.limit, self.minLevel, self.process) = (cursor, limit, minLevel, process)
    }

    private enum Key: String, CodingKey { case after, cursor, limit, minLevel = "min_level", process }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        try container.encodeIfPresent(after, forKey: .after)
        try container.encodeIfPresent(cursor, forKey: .cursor)
        try container.encodeIfPresent(limit, forKey: .limit)
        try container.encodeIfPresent(minLevel?.rawValue, forKey: .minLevel)
        try container.encodeIfPresent(process?.rawValue, forKey: .process)
    }

    /// The same query, reading before `cursor`.
    public func before(_ cursor: String?) -> LogQuery {
        var query = self
        query.cursor = cursor
        return query
    }

    /// The same query, reading only what was written after `head`.
    public func after(_ head: String?) -> LogQuery {
        var query = self
        query.after = head
        return query
    }
}
