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
    /// The log's end as last read: the live poll reads only what came after it.
    public private(set) var head: String?
    public private(set) var isFollowing = true
    /// The newest rows dropped to make room for older ones he read back to: the live poll reads nothing, and following
    /// again starts the feed over.
    public private(set) var isCut = false

    /// The feed of a first page.
    public init(first page: LogPage) {
        rows = page.lines.map(Row.line)
        (earlier, head) = (page.cursor, page.head)
        trim()
    }

    /// Nothing to show, and nothing older to read.
    public var isEmpty: Bool { rows.isEmpty && pending.isEmpty && earlier == nil }

    /// The lines that came while paused.
    public var newCount: Int { pending.count { $0.line != nil } }

    /// What the live poll read (`newer`): on top while following, else held until he follows; its head is the next
    /// poll's. `backAt` puts a "Back at" row under them (Life answers again), even over no new line. A page with a
    /// cursor left new lines unread under it: its lines take the feed's place (held while paused, the rows shown go, as
    /// the cap would take them), and older lines are read from there.
    public mutating func add(newer page: LogPage, backAt: Date? = nil) {
        head = page.head ?? head
        if let cursor = page.cursor {
            let new = page.lines.map(Row.line)
            (rows, pending) = isFollowing ? (new, []) : ([], new)
            earlier = cursor
            return
        }
        let hasRows = !rows.isEmpty || !pending.isEmpty
        guard !page.lines.isEmpty || (backAt != nil && hasRows) else { return }
        let added = page.lines.map(Row.line) + (backAt.map { [.back($0)] } ?? [])
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

    /// The live poll's one rule: the lines written after `head`, newest first, reading pages until none is left, at most
    /// `cap` (the log's order is the file's, never the lines' times, which writers stamp before appending), so the gap
    /// after Life did not answer loads whole, and a quiet poll is one read however far back the filter last matched.
    /// Its `cursor` is set when new lines were left unread under the ones read (over the cap; or no head yet, one page
    /// only); its `head` is the next poll's.
    public static func newer(
        after head: String?, read: @Sendable (_ cursor: String?) async throws -> LogPage
    ) async throws -> LogPage {
        var page = try await read(nil)
        let next = page.head
        var found: [LogLine] = []
        while true {
            for line in page.lines {
                found.append(line)
                if found.count == cap { return LogPage(lines: found, cursor: line.id, head: next) }
            }
            guard head != nil, let cursor = page.cursor else {
                return LogPage(lines: found, cursor: head == nil ? page.cursor : nil, head: next)
            }
            page = try await read(cursor)
        }
    }
}
