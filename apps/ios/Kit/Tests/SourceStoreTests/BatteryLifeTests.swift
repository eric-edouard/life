import Foundation
import Testing

@testable import SourceStore

private let now = Date(timeIntervalSince1970: 1_790_000_000)

/// A level dropping one point every `minutes`, `points` times, in one state, ending `endingAgo` before `now`.
private func drain(
    from percent: Int, points: Int, every minutes: Double, _ state: BatteryReading.State,
    endingAgo: TimeInterval = 0
) -> [BatteryReading] {
    let start = now.addingTimeInterval(-endingAgo - Double(points) * minutes * 60)
    return (0...points).map {
        BatteryReading(at: start.addingTimeInterval(Double($0) * minutes * 60), percent: percent - $0, state: state)
    }
}

@Test func saysNothingUntilEnoughWasSeen() {
    let life = BatteryLife(readings: drain(from: 80, points: 4, every: 30, .recording), now: now)
    #expect(life == BatteryLife())
    #expect(life.timeLeft(recording: true, from: 80) == nil)
}

@Test func learnsEachStateFromItsOwnSteps() throws {
    let readings =
        drain(from: 90, points: 10, every: 30, .recording, endingAgo: 86_400)
        + drain(from: 80, points: 6, every: 240, .paused)
    let life = BatteryLife(readings: readings, now: now)
    // The first step of each run is partial (the switch landed mid-percent) and is dropped.
    #expect(abs(try #require(life.recording) - 2) < 0.001)
    #expect(abs(try #require(life.paused) - 0.25) < 0.001)
    let hours = { (left: Duration?) in left.map { Int(($0 / .seconds(3_600)).rounded()) } }
    #expect(hours(life.timeLeft(recording: true, from: 50)) == 25)
    #expect(hours(life.timeLeft(recording: false, from: 50)) == 200)
}

@Test func dropsStepsWatchedOnlyInPart() {
    // Each drop is split by something unseen: a pause, a disconnection, a charge. None is a whole step.
    let t = { (minutes: Double) in now.addingTimeInterval(minutes * 60) }
    var readings: [BatteryReading] = []
    for step in 0..<10 {
        let base = Double(step) * 100
        let percent = 90 - step
        let interruption: BatteryReading.State = [.paused, .unobserved][step % 2]
        readings += [
            BatteryReading(at: t(base), percent: percent, state: .recording),
            BatteryReading(at: t(base + 10), percent: percent, state: interruption),
            BatteryReading(at: t(base + 20), percent: percent, state: .recording),
        ]
    }
    // A charge mid-run: the level rising ends the step too.
    readings += [
        BatteryReading(at: t(1_100), percent: 95, state: .recording),
        BatteryReading(at: t(1_130), percent: 94, state: .recording),
    ]
    #expect(BatteryLife(readings: readings, now: t(1_200)) == BatteryLife())
}

@Test func weighsTheLastWeekMost() throws {
    let readings =
        drain(from: 90, points: 20, every: 15, .recording, endingAgo: 28 * 86_400)  // 4 %/h, four weeks ago
        + drain(from: 90, points: 20, every: 30, .recording)  // 2 %/h, now
    let rate = try #require(BatteryLife(readings: readings, now: now).recording)
    #expect(rate > 2 && rate < 2.2)
}

@Test func storesAReadingOnlyWhenSomethingChanged() {
    let seen = BatteryReading(at: now, percent: 80, state: .recording)
    #expect(seen.toStore(after: nil)?.state == .unobserved)
    #expect(seen.toStore(after: BatteryReading(at: now - 60, percent: 80, state: .recording)) == nil)
    #expect(seen.toStore(after: BatteryReading(at: now - 60, percent: 81, state: .recording)) == seen)
    #expect(seen.toStore(after: BatteryReading(at: now - 60, percent: 80, state: .paused)) == seen)
}

@Test func batteryReadingsRoundTrip() async throws {
    let store = try SourceStore(
        directory: FileManager.default.temporaryDirectory.appending(path: "source-store-\(UUID().uuidString)"))
    let readings = drain(from: 80, points: 3, every: 30, .paused)
    for reading in readings { try await store.recordBatteryReading(reading, deviceID: "pendant-1") }
    #expect(try await store.batteryReadings(deviceID: "pendant-1", since: .distantPast) == readings)
    #expect(try await store.batteryReadings(deviceID: "pendant-1", since: readings[2].at) == Array(readings[2...]))
    #expect(try await store.batteryReadings(deviceID: "other", since: .distantPast).isEmpty)
}
