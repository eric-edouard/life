import Foundation
import Synchronization
import Testing

import Library

@testable import LifeConnector

/// A made-up line; its id is its second, as unique as the server's place in the log.
private func line(_ second: Int, _ message: String = "turn ended") -> LogLine {
    LogLine(
        id: "c\(second)", at: Date(timeIntervalSince1970: TimeInterval(second)), level: .info,
        category: ["desk", "turn"],
        message: message)
}

private func lines(_ feed: LogFeed) -> [String] { feed.rows.compactMap(\.line?.message) }

@Test func aPageOfLifesLogDecodes() throws {
    let page = try LibraryStore.feedDecoder.decode(LogPage.self, from: Data(wireText("life/read_log_lines.json").utf8))
    #expect(page.cursor != nil && page.head != nil)
    #expect(Set(page.lines.map(\.id)).count == page.lines.count)
    let error = try #require(page.lines.first)
    #expect(error.level == .error && error.level.tag == "ERR")
    #expect(error.categoryWords == "model·memory-extract.v2")
    #expect(error.parts.contains(.value("38 s")))
    #expect(page.lines[1].categoryWords == "connector·tell_life")
    #expect(page.lines[1].parts == [.text(page.lines[1].message)])
}

@Test func aQueryGivesTheToolsArguments() throws {
    let query = LogQuery(minLevel: .warn, process: .mcp).after("h1").before("c1")
    let sent = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(query)) as? [String: Any])
    #expect(sent["min_level"] as? String == "warn" && sent["process"] as? String == "mcp")
    #expect(sent["cursor"] as? String == "c1" && sent["after"] as? String == "h1" && sent["limit"] as? Int == 100)
    #expect(try String(decoding: JSONEncoder().encode(LogQuery(limit: nil)), as: UTF8.self) == "{}")
}

/// A poll's pages by cursor ("" the first), and the cursors it asked.
private final class Pages: Sendable {
    let pages: [String: LogPage]
    let asked = Mutex<[String]>([])

    init(_ pages: [String: LogPage]) { self.pages = pages }

    var read: @Sendable (String?) async throws -> LogPage {
        { cursor in
            self.asked.withLock { $0.append(cursor ?? "") }
            return self.pages[cursor ?? ""]!
        }
    }

    var cursors: [String] { asked.withLock { $0 } }
}

@Test func theLivePollReadsEverythingAfterTheHeadAcrossAGap() async throws {
    let gap = Pages([
        "": LogPage(lines: [line(13), line(12)], cursor: "a", head: "h1"),
        "a": LogPage(lines: [line(11)], cursor: nil),
    ])
    let new = try await LogFeed.newer(after: "h0", read: gap.read)
    #expect(new == LogPage(lines: [line(13), line(12), line(11)], cursor: nil, head: "h1"))
    #expect(gap.cursors == ["", "a"])
    // A quiet poll is one read, however far back the filter last matched.
    let quiet = Pages(["": LogPage(lines: [], cursor: nil, head: "h1")])
    #expect(try await LogFeed.newer(after: "h1", read: quiet.read).lines.isEmpty)
    #expect(quiet.cursors == [""])
    // No head yet (no log when the feed began): one page, its cursor kept for the older lines.
    let first = Pages(["": LogPage(lines: [line(12)], cursor: "x", head: "h")])
    var feed = LogFeed(first: LogPage(lines: [], cursor: nil))
    feed.add(newer: try await LogFeed.newer(after: nil, read: first.read))
    #expect(lines(feed) == ["turn ended"] && feed.earlier == "x" && feed.head == "h")
}

@Test func anEmptyFeedsFirstLinesAllArriveOnce() async throws {
    var feed = LogFeed(first: LogPage(lines: [], cursor: nil, head: "h0"))
    let pages = Pages([
        "": LogPage(lines: (2...101).reversed().map { line($0) }, cursor: "a", head: "h1"),
        "a": LogPage(lines: [line(1)], cursor: nil),
    ])
    feed.add(newer: try await LogFeed.newer(after: feed.head, read: pages.read))
    let ids = feed.rows.compactMap(\.line?.id)
    #expect(ids.count == 101 && Set(ids).count == 101 && feed.earlier == nil && feed.head == "h1")
}

@Test func overTheCapAPollStartsTheFeedFromItsNewestLines() async throws {
    var feed = LogFeed(first: LogPage(lines: [line(0, "old")], cursor: nil, head: "h0"))
    let pages = Pages([
        "": LogPage(lines: (1...LogFeed.cap + 1).reversed().map { line($0) }, cursor: "a", head: "h1")
    ])
    let new = try await LogFeed.newer(after: feed.head, read: pages.read)
    #expect(new.lines.count == LogFeed.cap && new.cursor == "c2")
    feed.add(newer: new)
    #expect(feed.rows.count == LogFeed.cap && !lines(feed).contains("old") && feed.earlier == "c2")
}

@Test func pausedLinesWaitThenGoOnTop() {
    var feed = LogFeed(first: LogPage(lines: [line(2, "b"), line(1, "a")], cursor: "older"))
    feed.add(newer: LogPage(lines: [line(3, "c")], cursor: nil))
    #expect(lines(feed) == ["c", "b", "a"])
    feed.pause()
    feed.add(newer: LogPage(lines: [line(4, "d")], cursor: nil))
    feed.add(newer: LogPage(lines: [line(5, "e")], cursor: nil), backAt: Date(timeIntervalSince1970: 6))
    #expect(lines(feed) == ["c", "b", "a"] && feed.newCount == 2)
    feed.follow()
    #expect(lines(feed) == ["e", "d", "c", "b", "a"] && feed.newCount == 0)
    // The divider sits under the lines that came back; after a quiet gap, it sits on top alone.
    if case .back = feed.rows[1] {} else { Issue.record("no Back at row") }
    feed.add(newer: LogPage(lines: [], cursor: nil, head: "h9"), backAt: Date(timeIntervalSince1970: 7))
    if case .back = feed.rows[0] {} else { Issue.record("no Back at row after a quiet gap") }
    #expect(feed.head == "h9")
    // An empty feed shows no divider.
    var empty = LogFeed(first: LogPage(lines: [], cursor: nil))
    empty.add(newer: LogPage(lines: [], cursor: nil), backAt: Date())
    #expect(empty.rows.isEmpty)
}

@Test func theOldestDropOffAndOlderLinesAreReadFromUnderTheOldestKept() {
    var feed = LogFeed(first: LogPage(lines: (0..<LogFeed.cap).map { line(LogFeed.cap - $0) }, cursor: "older"))
    #expect(feed.earlier == "older")
    feed.add(newer: LogPage(lines: [line(LogFeed.cap + 1, "new")], cursor: nil))
    #expect(feed.rows.count == LogFeed.cap && lines(feed).first == "new")
    #expect(feed.earlier == feed.rows.last?.id && feed.earlier == "c2")
    // Shown and pending count together.
    feed.pause()
    feed.add(newer: LogPage(lines: [line(LogFeed.cap + 3), line(LogFeed.cap + 2)], cursor: nil))
    #expect(feed.rows.count + feed.pending.count == LogFeed.cap && feed.earlier == "c4")
}

@Test func readingBackPastTheCapDropsTheNewestAndFollowingStartsOver() {
    var feed = LogFeed(first: LogPage(lines: (0..<LogFeed.cap).map { line(1000 - $0) }, cursor: "older"))
    feed.pause()
    feed.add(newer: LogPage(lines: [line(2000, "pending")], cursor: nil))
    feed.add(earlier: LogPage(lines: [line(1, "oldest")], cursor: "more"))
    #expect(feed.rows.count == LogFeed.cap && feed.pending.isEmpty && lines(feed).last == "oldest")
    #expect(feed.isCut && !feed.isFollowing && feed.earlier == "more")
}

@Test func olderPagesAddBelowUntilTheEnd() {
    var feed = LogFeed(first: LogPage(lines: [], cursor: "a"))
    #expect(!feed.isEmpty)
    feed.add(earlier: LogPage(lines: [], cursor: "b"))
    feed.add(earlier: LogPage(lines: [line(1, "old")], cursor: nil))
    #expect(lines(feed) == ["old"] && feed.earlier == nil && !feed.isCut)
    #expect(LogFeed(first: LogPage(lines: [], cursor: nil)).isEmpty)
}
