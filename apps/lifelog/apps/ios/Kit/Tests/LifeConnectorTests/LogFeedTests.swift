import Foundation
import Testing

import Library

@testable import LifeConnector

private func line(_ second: Int, _ message: String = "turn ended", level: LogLevel = .info) -> LogLine {
    LogLine(at: Date(timeIntervalSince1970: TimeInterval(second)), level: level, category: ["desk", "turn"], message: message)
}

private func lines(_ feed: LogFeed) -> [String] { feed.rows.compactMap(\.line?.message) }

@Test func aPageOfLifesLogDecodes() throws {
    let page = try LibraryStore.feedDecoder.decode(LogPage.self, from: Data(wireText("life/read_log_lines.json").utf8))
    #expect(page.cursor != nil)
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
    #expect(try JSONSerialization.jsonObject(with: JSONEncoder().encode(LogQuery(limit: nil))) as? [String: Any] == [:])
}

@Test func theLivePollReadsBackToTheTopAcrossAGap() async throws {
    let top = line(10, "top")
    // Newest first: three new lines over two pages, then the top.
    let pages = ["": LogPage(lines: [line(13), line(12)], cursor: "a"), "a": LogPage(lines: [line(11), top, line(9)], cursor: "b")]
    var asked: [String] = []
    let new = try await LogFeed.newer(than: top) { cursor in
        asked.append(cursor ?? "")
        return pages[cursor ?? ""]!
    }
    #expect(new == [line(13), line(12), line(11)])
    #expect(asked == ["", "a"])
    // A top no longer in the log ends the read at the first older line; no top reads one page.
    #expect(try await LogFeed.newer(than: line(10, "gone")) { _ in LogPage(lines: [line(12), line(8)], cursor: "x") } == [line(12)])
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
    #expect(Set(feed.rows.map(\.id)).count == feed.rows.count)
}

@Test func theOldestDropOffAndThenNothingOlderIsRead() {
    var feed = LogFeed(first: LogPage(lines: (0..<LogFeed.cap).map { line(LogFeed.cap - $0) }, cursor: "older"))
    #expect(!feed.isTrimmed && feed.earlier == "older")
    feed.add(newer: [line(LogFeed.cap + 1, "new")])
    #expect(feed.rows.count == LogFeed.cap && feed.isTrimmed && feed.earlier == nil && !feed.isEmpty)
    #expect(lines(feed).first == "new")
}

@Test func olderPagesAddBelowUntilTheEnd() {
    var feed = LogFeed(first: LogPage(lines: [], cursor: "a"))
    #expect(!feed.isEmpty)
    feed.add(earlier: LogPage(lines: [], cursor: "b"))
    feed.add(earlier: LogPage(lines: [line(1, "old")], cursor: nil))
    #expect(lines(feed) == ["old"] && feed.earlier == nil && !feed.isTrimmed)
    #expect(LogFeed(first: LogPage(lines: [], cursor: nil)).isEmpty)
}
