import Foundation
import Incidents

nonisolated extension PendantSnapshot {
    /// The Pendant widget.
    static let widgetKind = "RecordingStatus"

    /// The last snapshot the app wrote, or `nil` before the first.
    static func load() -> PendantSnapshot? {
        AppGroup.defaults.data(forKey: AppGroup.Key.pendantSnapshot).flatMap {
            try? JSONDecoder().decode(PendantSnapshot.self, from: $0)
        }
    }

    func save() {
        AppGroup.defaults.set(try? JSONEncoder().encode(self), forKey: AppGroup.Key.pendantSnapshot)
    }
}
