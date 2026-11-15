import HealthKit
import Observation
import ServerAPI
import UIKit

/// Health is the durable store; only each kind's acknowledged end is kept on the phone.
@Observable
final class AppleHealthReader {
    private let store = HKHealthStore()
    private var task: Task<Void, Never>?
    private var isSyncing = false
    private var lastStarted: ContinuousClock.Instant?

    private static let types: [(AppleHealthMeasurement.Kind, HKSampleType)] = [
        (.sleep, HKCategoryType(.sleepAnalysis)), (.workout, HKWorkoutType.workoutType()),
    ]

    static var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }
    private static var readTypes: Set<HKObjectType> { Set(types.map { $0.1 }) }

    /// Called only from Settings while the app is open. Read authorization is never reported as "allowed".
    static func claim() async throws {
        guard isAvailable else { return }
        try await HKHealthStore().requestAuthorization(toShare: [], read: readTypes)
    }

    static func hasAsked() async throws -> Bool {
        guard isAvailable else { return false }
        return try await HKHealthStore().statusForAuthorizationRequest(toShare: [], read: readTypes) == .unnecessary
    }

    func start() {
        guard Self.isAvailable, task == nil else { return }
        task = Task {
            while !Task.isCancelled {
                await sync()
                do { try await Task.sleep(for: .seconds(3600)) } catch { return }
            }
        }
    }

    /// ponytail: deletions and arrivals over seven days late stay unsent; upgrade to anchored queries and tombstones.
    func sync() async {
        guard Self.isAvailable, UIApplication.shared.isProtectedDataAvailable,
            DeviceToken.paired != nil, !isSyncing,
            lastStarted.map({ $0.duration(to: .now) >= .seconds(3600) }) ?? true
        else { return }
        isSyncing = true
        defer { isSyncing = false }
        do {
            guard try await Self.hasAsked() else { return }
            lastStarted = .now
            for (kind, type) in Self.types {
                do {
                    try Task.checkCancellation()
                    let key = "apple-health.syncedThrough.\(kind.rawValue)"
                    let syncedThrough = UserDefaults.standard.object(forKey: key) as? Date
                    let from = AppleHealthMeasurement.queryStartOf(syncedThrough: syncedThrough)
                    let measurements = try await readMeasurements(type: type, from: from)
                    for chunk in AppleHealthMeasurement.chunksOf(measurements) {
                        try Task.checkCancellation()
                        try await ServerClient.production.addAppleHealth(chunk)
                        if let end = chunk.last?.endAt {
                            UserDefaults.standard.set(max(syncedThrough ?? end, end), forKey: key)
                        }
                    }
                } catch {
                    if error is CancellationError { return }
                    _ = report(error)
                }
            }
        } catch { _ = report(error) }
    }

    private func readMeasurements(type: HKSampleType, from: Date?) async throws -> [AppleHealthMeasurement] {
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: type,
                predicate: HKQuery.predicateForSamples(withStart: from, end: nil),
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: true)]
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: (samples ?? []).compactMap(AppleHealthMeasurement.init))
                }
            }
            store.execute(query)
        }
    }
}
