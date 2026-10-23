import Foundation
import Glance
import Testing

private let now = Date(timeIntervalSince1970: 1_800_000_000)

@Test func resetCountdownFitsTheDialAndNeverInventsANewWindow() {
    func countdown(_ seconds: Double) -> String {
        SubscriptionUsage.Window(usedPercent: 35, resetsAt: now.timeIntervalSince1970 + seconds).countdown(now: now)
    }
    #expect(countdown(5 * 86_400) == "5D")
    #expect(countdown(80 * 60) == "1H 20M")
    #expect(countdown(60 * 60) == "1H 0M")
    #expect(countdown(61) == "2M")
    #expect(countdown(1) == "1M")
    #expect(countdown(0) == "↻")
    #expect(countdown(-300) == "↻")
}

@Test func missingAndStaleLimitsAreNotAnUnusedPlan() throws {
    let reading = try JSONDecoder().decode(
        SubscriptionUsage.self,
        from: Data(
            #"{"observedAt":1800000000,"fiveHour":null,"sevenDay":{"usedPercent":0,"resetsAt":1800600000}}"#.utf8))
    #expect(reading.fiveHour == nil)
    #expect(reading.sevenDay?.usedPercent == 0)
    #expect(!reading.isStale(now: now))
    #expect(reading.isStale(now: now.addingTimeInterval(3600)))
}
