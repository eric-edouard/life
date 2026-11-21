import Foundation

/// The Live logs page's lines, newest first: what it holds, what came while he was paused, and how to read older ones.
/// Pure: the page's store reads Life and hands each page here.
public struct LogFeed: Sendable, Equatable {
    /// A row of the list: a line, or where the page came back after Life did not answer ("Back at 14:40").
    public enum Row: Sendable, Equatable, Identifiable {
        case line(id: Int, LogLine)
        case back(id: Int, Date)

        public var id: Int {
            switch self {
            case .line(let id, _), .back(let id, _): id
            }
        }

        var line: LogLine? { if case .line(_, let line) = self { line } else { nil } }
    }

    /// The most rows held at once; the oldest drop off.
    public static let cap = 500

    public private(set) var rows: [Row] = []
    /// Rows that came while paused, newest first: on top once he follows again.
    public private(set) var pending: [Row] = []
    /// Where older lines are read from; nil once none is left, or once the oldest rows dropped off.
    public private(set) var earlier: String?
    /// The oldest rows dropped off: nothing older is read, and the list does not end in "Nothing earlier".
    public private(set) var isTrimmed = false
    public private(set) var isFollowing = true
    private var nextID = 0

    /// The feed of a first page.
    public init(first page: LogPage) {
        rows = rowsOf(page.lines)
        earlier = page.cursor
    }

    /// Nothing to show, and nothing older to read.
    public var isEmpty: Bool { rows.isEmpty && pending.isEmpty && earlier == nil }

    /// The lines that came while paused.
    public var newCount: Int { pending.count { $0.line != nil } }

    /// The newest line held: where the live poll reads up to.
    public var top: LogLine? { (pending + rows).lazy.compactMap(\.line).first }

    /// Lines newer than `top`, newest first: on top while following, else held until he follows. `backAt` puts a
    /// "Back at" row under them (Life answers again). Gives the ids of the rows added.
    @discardableResult
    public mutating func add(newer lines: [LogLine], backAt: Date? = nil) -> [Int] {
        guard !lines.isEmpty else { return [] }
        var added = rowsOf(lines)
        if let backAt {
            added.append(.back(id: nextID, backAt))
            nextID += 1
        }
        if isFollowing {
            rows = added + rows
            trim()
        } else {
            pending = Array((added + pending).prefix(Self.cap))
        }
        return added.map(\.id)
    }

    /// An older page, read from `earlier`.
    public mutating func add(earlier page: LogPage) {
        rows += rowsOf(page.lines)
        earlier = page.cursor
        trim()
    }

    public mutating func pause() { isFollowing = false }

    /// Following again: what came while paused goes on top.
    public mutating func follow() {
        rows = pending + rows
        pending = []
        isFollowing = true
        trim()
    }

    // ponytail: a trimmed list reads nothing older (a cursor points under a page, not under any line); keep each
    // page's cursor if he ever needs more than 500 lines back.
    private mutating func trim() {
        guard rows.count > Self.cap else { return }
        rows = Array(rows.prefix(Self.cap))
        earlier = nil
        isTrimmed = true
    }

    private mutating func rowsOf(_ lines: [LogLine]) -> [Row] {
        defer { nextID += lines.count }
        return lines.enumerated().map { .line(id: nextID + $0.offset, $0.element) }
    }

    /// The live poll's one rule: the lines newer than `top`, reading newest pages back until one reaches it (holds it,
    /// or a line older than it), so the gap after Life did not answer loads whole; at most `cap` lines.
    public static func newer(
        than top: LogLine?, read: (_ cursor: String?) async throws -> LogPage
    ) async throws -> [LogLine] {
        var found: [LogLine] = []
        var cursor: String?
        repeat {
            let page = try await read(cursor)
            for line in page.lines {
                if let top, line == top || line.at < top.at { return found }
                found.append(line)
                if found.count == cap { return found }
            }
            cursor = page.cursor
        } while top != nil && cursor != nil
        return found
    }
}
