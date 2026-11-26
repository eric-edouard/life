import Foundation
import Testing

@testable import LifeConnector

private let t0 = Date(timeIntervalSince1970: 1_795_111_200)
private let minute: TimeInterval = 60

private func read(_ refs: [(String, String)], opening: [String], state: (String) -> String = { _ in "needs_you" })
    throws -> ThreadRead
{
    let items = refs.map { ref, group in
        #"{"kind":"ask","ref":"\#(ref)","state":"\#(state(ref))","card":{"ref":"\#(ref)","group":"\#(group)","title":"T","question":"Q","asker":"Life","options":[],"clips":[],"likelyPeople":[],"links":[]}}"#
    }
    let list = opening.map { #""\#($0)""# }.joined(separator: ",")
    return try ThreadRead.parsed(
        #"{"owner":"Kit","opening":[\#(list)],"items":[\#(items.joined(separator: ","))]}"#)
}

@Test func theScreenOpensCleanAtLaunchAndAfterFiveMinutesAwayButNotSooner() {
    var o = Opening()
    let atLaunch = o.came(at: t0)
    // Inactive and back (a notification pulled down): nothing changes.
    let inactive = o.came(at: t0 + minute)
    o.left(at: t0 + 2 * minute)
    let sooner = o.came(at: t0 + 6 * minute)
    #expect(atLaunch && !inactive && !sooner && o.at == t0)
    o.left(at: t0 + 10 * minute)
    let later = o.came(at: t0 + 15 * minute)
    #expect(later)
    #expect(o.at == t0 + 15 * minute && o.earlier == [t0])
}

@Test func brokenIsNeverCappedThenThreeAsksThatBlockAndTheRestBehindThePill() throws {
    var o = Opening()
    o.came(at: t0)
    let page = try read(
        [
            ("fix:a", "fix"), ("fix:b", "fix"), ("d1", "decision"), ("d2", "decision"), ("d3", "decision"),
            ("d4", "decision"), ("d5", "decision"), ("d6", "decision"),
        ],
        opening: ["d5", "d1", "d6", "d2", "d3", "d4"], state: { $0 == "d6" ? "later" : "needs_you" })
    #expect(page.owner == "Kit")
    o.take(page)
    #expect(o.broken == ["fix:a", "fix:b"])
    // Life's order, an ask his Later holds left out.
    #expect(o.top == ["d5", "d1", "d2"] && o.more == ["d3", "d4"])
}

@Test func rowsKeepTheirPlaceWhileHeAnswersAndANewFixShowsAtOnce() throws {
    var o = Opening()
    o.came(at: t0)
    o.take(try read([("d1", "decision"), ("d2", "decision")], opening: ["d1", "d2"]))
    // d1 answered: it leaves Life's opening, its row stays; LINE breaks meanwhile.
    o.take(try read([("fix:line", "fix"), ("d1", "decision"), ("d2", "decision")], opening: ["d2"]))
    #expect(o.top == ["d1", "d2"] && o.broken == ["fix:line"])
    // The next opening starts over from Life's read.
    o.left(at: t0 + minute)
    o.came(at: t0 + 7 * minute)
    o.take(try read([("d2", "decision")], opening: ["d2"]))
    #expect(o.top == ["d2"] && o.broken.isEmpty)
}

@Test func showEarlierBringsBackTheThreadADayAtATime() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let day: TimeInterval = 86_400
    let dates = [t0 - 3 * day, t0 - day - 3600, t0 - day, t0 - 600, t0 + minute]
    var o = Opening()
    let beforeAny = o.isShown(t0 - 9 * day)
    var counts: [Int] = []
    o.came(at: t0)
    for _ in 0..<4 {
        let shown = o
        counts.append(dates.filter { shown.isShown($0) }.count)
        o.showEarlier(of: dates, calendar: calendar)
    }
    // Thursday's own earlier entry, then Wednesday's two, then Monday's.
    #expect(beforeAny && counts == [1, 2, 4, 5])
    #expect(o.earlierDay(of: dates, calendar: calendar) == nil)
}
