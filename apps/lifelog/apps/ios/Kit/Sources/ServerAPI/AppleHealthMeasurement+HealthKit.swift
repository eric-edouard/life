import Foundation
import HealthKit

extension AppleHealthMeasurement {
    /// Only sleep and workouts, in the units the server's contract names.
    public init?(_ sample: HKSample) {
        let content: Content
        if let sleep = sample as? HKCategorySample,
            sleep.categoryType == HKCategoryType(.sleepAnalysis)
        {
            let stage: Stage
            switch HKCategoryValueSleepAnalysis(rawValue: sleep.value) {
            case .inBed: stage = .inBed
            case .awake: stage = .awake
            case .asleepCore: stage = .core
            case .asleepDeep: stage = .deep
            case .asleepREM: stage = .rem
            case .asleepUnspecified: stage = .asleep
            default: return nil
            }
            content = .sleep(stage)
        } else if let workout = sample as? HKWorkout {
            content = .workout(
                activity: Self.activityOf(workout.workoutActivityType),
                kcal: workout.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity()?.doubleValue(
                    for: .kilocalorie()))
        } else {
            return nil
        }
        self.init(
            id: sample.uuid.uuidString.lowercased(), startAt: sample.startDate, endAt: sample.endDate,
            content: content)
    }

    public static func activityOf(_ activity: HKWorkoutActivityType) -> String {
        switch activity {
        case .running: "running"
        case .walking: "walking"
        case .cycling: "cycling"
        case .swimming: "swimming"
        case .traditionalStrengthTraining, .functionalStrengthTraining: "strength_training"
        case .hiking: "hiking"
        case .yoga: "yoga"
        case .highIntensityIntervalTraining: "hiit"
        default: "other"
        }
    }
}
