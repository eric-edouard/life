import Foundation

/// The Live logs page's lines, newest first: what it shows, what came while he was paused, and where older lines are
/// read from. Pure: the page's store reads Life and hands each page here.
public struct LogFeed: Sendable, Equatable {
    /// A row of the list: a line, or where Life answered again after it did not ("Back at 14:40").
    public enum Row: Sendable, Equatable, Identifiable {
        case line(LogLine)
        case back(Date)

        public var id: String {
            switch self {
            case .line(let line): line.id
            case .back(let at): "back \(at.timeIntervalSince1970)"
            }
        }

        public var line: LogLine? { if case .line(let line) = self { line } else { nil } }
    }

    /// The most rows held at once, shown and pending together; the oldest drop off.
    public static let cap = 500

    public private(set) var rows: [Row] = []
    /// Rows that came while paused, newest first: on top once he follows again.
    public private(set) var pending: [Row] = []
    /// Where older lines are read from; nil once none is left.
    public private(set) var earlier: String?
    public private(set) var isFollowing = true
    /// The newest rows dropped to make room for older ones he read back to: the live poll reads nothing, and following
    /// again starts the feed over.
    public private(set) var isCut = false

    /// The feed of a first page.
    public init(first page: LogPage) {
        rows = page.lines.map(Row.line)
        earlier = page.cursor
        trim()
    }

    /// Nothing to show, and nothing older to read.
    public var isEmpty: Bool { rows.isEmpty && pending.isEmpty && earlier == nil }

    /// The lines that came while paused.
    public var newCount: Int { pending.count { $0.line != nil } }

    /// The newest line held: where the live poll reads back to.
    public var top: LogLine? { (pending + rows).lazy.compactMap(\.line).first }

    /// Lines newer than `top`, newest first: on top while following, else held until he follows. `backAt` puts a
    /// "Back at" row under them (Life answers again).
    public mutating func add(newer lines: [LogLine], backAt: Date? = nil) {
        guard !lines.isEmpty else { return }
        let added = lines.map(Row.line) + (backAt.map { [.back($0)] } ?? [])
        if isFollowing { rows = added + rows } else { pending = added + pending }
        trim()
    }

    /// An older page, read from `earlier`. Over the cap, the newest go (pending first), not the page just read.
    public mutating func add(earlier page: LogPage) {
        rows += page.lines.map(Row.line)
        earlier = page.cursor
        var over = rows.count + pending.count - Self.cap
        guard over > 0 else { return }
        let held = min(over, pending.count)
        pending.removeFirst(held)
        over -= held
        rows.removeFirst(over)
        isCut = true
        isFollowing = false
    }

    public mutating func pause() { isFollowing = false }

    /// Following again: what came while paused goes on top.
    public mutating func follow() {
        rows = pending + rows
        pending = []
        isFollowing = true
    }

    /// Over the cap after newer lines, the oldest shown rows go first, then the oldest pending; older lines are then
    /// read from under the oldest line kept (its id is that cursor).
    private mutating func trim() {
        var over = rows.count + pending.count - Self.cap
        guard over > 0 else { return }
        let shown = min(over, rows.count)
        rows.removeLast(shown)
        over -= shown
        pending.removeLast(over)
        earlier = (pending + rows).last { $0.line != nil }?.id
    }

    /// The live poll's one rule: the lines newer than `top`, reading newest pages back until one holds it (by id: the
    /// log's order is the file's, never the lines' times, which writers stamp before appending), so the gap after Life
    /// did not answer loads whole; at most `cap` lines.
    public static func newer(
        than top: LogLine?, read: @Sendable (_ cursor: String?) async throws -> LogPage
    ) async throws -> [LogLine] {
        var found: [LogLine] = []
        var cursor: String?
        repeat {
            let page = try await read(cursor)
            for line in page.lines {
                if line.id == top?.id { return found }
                found.append(line)
                if found.count == cap { return found }
            }
            cursor = page.cursor
        } while top != nil && cursor != nil
        return found
    }
}
