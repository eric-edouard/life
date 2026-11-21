import Foundation
import Synchronization
import Testing

import Library

@testable import LifeConnector

/// A made-up line; its id is its second, as unique as the server's place in the log.
private func line(_ second: Int, _ message: String = "turn ended") -> LogLine {
    LogLine(
        id: "c\(second)", at: Date(timeIntervalSince1970: TimeInterval(second)), level: .info, category: ["desk", "turn"],
        message: message)
}

private func lines(_ feed: LogFeed) -> [String] { feed.rows.compactMap(\.line?.message) }

@Test func aPageOfLifesLogDecodes() throws {
    let page = try LibraryStore.feedDecoder.decode(LogPage.self, from: Data(wireText("life/read_log_lines.json").utf8))
    #expect(page.cursor != nil)
    #expect(Set(page.lines.map(\.id)).count == page.lines.count)
    let error = try #require(page.lines.first)
    #expect(error.level == .error && error.level.tag == "ERR")
    #expect(error.categoryWords == "model·memory-extract.v2")
    #expect(error.parts.contains(.value("38 s")))
    #expect(page.lines[1].categoryWords == "connector·tell_life")
    #expect(page.lines[1].parts == [.text(page.lines[1].message)])
}

@Test func aQueryGivesTheToolsArguments() throws {
    let query = LogQuery(minLevel: .warn, process: .mcp).before("c1")
    let sent = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(query)) as? [String: Any])
    #expect(sent["min_level"] as? String == "warn" && sent["process"] as? String == "mcp")
    #expect(sent["cursor"] as? String == "c1" && sent["limit"] as? Int == 100)
    #expect(try String(decoding: JSONEncoder().encode(LogQuery(limit: nil)), as: UTF8.self) == "{}")
}

@Test func theLivePollReadsBackToTheTopAcrossAGap() async throws {
    let top = line(10, "top")
    // Newest first: three new lines over two pages, then the top.
    let pages = ["": LogPage(lines: [line(13), line(12)], cursor: "a"), "a": LogPage(lines: [line(11), top, line(9)], cursor: "b")]
    let asked = Mutex<[String]>([])
    let new = try await LogFeed.newer(than: top) { cursor in
        asked.withLock { $0.append(cursor ?? "") }
        return pages[cursor ?? ""]!
    }
    #expect(new == [line(13), line(12), line(11)])
    #expect(asked.withLock { $0 } == ["", "a"])
    // Order is the log's, never the times: a line stamped earlier but written later is still new; no top reads one page.
    #expect(try await LogFeed.newer(than: top) { _ in LogPage(lines: [line(9, "late"), top], cursor: "x") } == [line(9, "late")])
    #expect(try await LogFeed.newer(than: nil) { _ in LogPage(lines: [line(12)], cursor: "x") } == [line(12)])
}

@Test func pausedLinesWaitThenGoOnTop() {
    var feed = LogFeed(first: LogPage(lines: [line(2, "b"), line(1, "a")], cursor: "older"))
    feed.add(newer: [line(3, "c")])
    #expect(lines(feed) == ["c", "b", "a"])
    feed.pause()
    feed.add(newer: [line(4, "d")])
    feed.add(newer: [line(5, "e")], backAt: Date(timeIntervalSince1970: 6))
    #expect(lines(feed) == ["c", "b", "a"] && feed.newCount == 2)
    #expect(feed.top == line(5, "e"))
    feed.follow()
    #expect(lines(feed) == ["e", "d", "c", "b", "a"] && feed.newCount == 0)
    // The divider sits under the lines that came back.
    if case .back = feed.rows[1] {} else { Issue.record("no Back at row") }
}

@Test func theOldestDropOffAndOlderLinesAreReadFromUnderTheOldestKept() {
    var feed = LogFeed(first: LogPage(lines: (0..<LogFeed.cap).map { line(LogFeed.cap - $0) }, cursor: "older"))
    #expect(feed.earlier == "older")
    feed.add(newer: [line(LogFeed.cap + 1, "new")])
    #expect(feed.rows.count == LogFeed.cap && lines(feed).first == "new")
    #expect(feed.earlier == feed.rows.last?.id && feed.earlier == "c2")
    // Shown and pending count together.
    feed.pause()
    feed.add(newer: [line(LogFeed.cap + 2), line(LogFeed.cap + 3)].reversed())
    #expect(feed.rows.count + feed.pending.count == LogFeed.cap && feed.earlier == "c4")
}

@Test func readingBackPastTheCapDropsTheNewestAndFollowingStartsOver() {
    var feed = LogFeed(first: LogPage(lines: (0..<LogFeed.cap).map { line(1000 - $0) }, cursor: "older"))
    feed.pause()
    feed.add(newer: [line(2000, "pending")])
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
