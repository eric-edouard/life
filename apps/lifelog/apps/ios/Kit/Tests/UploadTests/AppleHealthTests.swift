import Foundation
import HealthKit
import ServerAPI
import Testing

private let start = Date(timeIntervalSince1970: 1_700_000_000)

private func wire(_ measurement: AppleHealthMeasurement) throws -> [String: Any] {
    try #require(JSONSerialization.jsonObject(with: ServerClient.encode(measurement)) as? [String: Any])
}

@Test func appleHealthEncodesOnlyEachKindsFields() throws {
    let contents: [AppleHealthMeasurement.Content] = [
        .sleep(.rem), .workout(activity: "running", kcal: 123), .workout(activity: "yoga", kcal: nil),
    ]
    for content in contents {
        let measurement = AppleHealthMeasurement(id: "made-up", startAt: start, endAt: start, content: content)
        let encoded = try wire(measurement)
        #expect(encoded["id"] as? String == "made-up")
        #expect(encoded["kind"] as? String == measurement.kind.rawValue)
        #expect(encoded["startAt"] as? String == "2023-11-14T22:13:20.000Z")
        #expect(encoded["endAt"] as? String == encoded["startAt"] as? String)
        let fields = Set(encoded.keys).subtracting(["id", "kind", "startAt", "endAt"])
        switch content {
        case .sleep:
            #expect(fields == ["stage"])
            #expect(encoded["stage"] as? String == "rem")
        case .workout(let activity, let kcal):
            #expect(fields == (kcal == nil ? ["activity"] : ["activity", "kcal"]))
            #expect(encoded["activity"] as? String == activity)
            #expect(encoded["kcal"] as? Double == kcal)
        }
    }
}

@Test func appleHealthMapsSamplesAndResumesInBoundedChunks() throws {
    let sleep = HKCategorySample(
        type: HKCategoryType(.sleepAnalysis), value: HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
        start: start, end: start.addingTimeInterval(60))
    let mapped = try #require(AppleHealthMeasurement(sleep))
    #expect(mapped.id == sleep.uuid.uuidString.lowercased())
    #expect(try wire(mapped)["stage"] as? String == "deep")
    for (type, unit, value) in [
        (HKQuantityType(.restingHeartRate), HKUnit.count().unitDivided(by: .minute()), 60.0),
        (HKQuantityType(.heartRateVariabilitySDNN), HKUnit.secondUnit(with: .milli), 35.0),
        (HKQuantityType(.bodyMass), HKUnit.gramUnit(with: .kilo), 65.0),
    ] {
        let sample = HKQuantitySample(
            type: type, quantity: HKQuantity(unit: unit, doubleValue: value), start: start, end: start)
        #expect(AppleHealthMeasurement(sample) == nil)
    }
    #expect(AppleHealthMeasurement.activityOf(.traditionalStrengthTraining) == "strength_training")
    #expect(AppleHealthMeasurement.activityOf(.highIntensityIntervalTraining) == "hiit")
    #expect(AppleHealthMeasurement.activityOf(.other) == "other")
    #expect(AppleHealthMeasurement.queryStartOf(syncedThrough: nil) == nil)
    let measurements = (0..<2001).reversed().map {
        AppleHealthMeasurement(
            id: "sleep-\($0)", startAt: start.addingTimeInterval(Double($0) * 3600),
            endAt: start.addingTimeInterval(Double($0 + 1) * 3600), content: .sleep(.asleep))
    }
    let chunks = AppleHealthMeasurement.chunksOf(measurements)
    #expect(chunks.map(\.count) == [1000, 1000, 1])
    #expect(chunks[0][0].id == "sleep-0")
    let acknowledged = try #require(chunks[0].last?.endAt)
    let queryStart = AppleHealthMeasurement.queryStartOf(syncedThrough: acknowledged)
    #expect(queryStart == acknowledged.addingTimeInterval(-604800))
    #expect(chunks[1][0].endAt > acknowledged)
    #expect(AppleHealthMeasurement.chunksOf([]).isEmpty)
}
