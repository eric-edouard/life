import CoreLocation
import Observation
import SwiftUI
import UserNotifications

/// Notifications, location and Apple Health, which Settings asks for and shows. Bluetooth's state is read from
/// `CaptureStore.context`. Read fresh whenever the screen comes forward.
@Observable
final class PermissionsStore {
    enum Access: Equatable {
        case allowed
        case asked
        case limited(String)
        case notAsked
        case denied
        case restricted
    }

    enum Kind: String { case notifications, location, appleHealth }

    private(set) var notifications = Access.allowed
    private(set) var location = Access.allowed
    private(set) var appleHealth = Access.notAsked
    /// Each Allow's tap: asking iOS, then its answer for 2 s, or why iOS never asked (`RowState.tap`).
    private(set) var asks: [Kind: RowState] = [:]
    /// Kept alive so its authorization prompt stays up.
    @ObservationIgnored private let locationManager = CLLocationManager()

    init(notifications: Access = .allowed, location: Access = .allowed) {
        self.notifications = notifications
        self.location = location
    }

    func refresh() async {
        if AppleHealthReader.isAvailable {
            do { appleHealth = try await AppleHealthReader.hasAsked() ? .asked : .notAsked } catch { _ = report(error) }
        } else {
            appleHealth = .restricted
        }
        notifications =
            switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
            case .authorized: .allowed
            case .provisional, .ephemeral: .limited("Delivered quietly")
            case .denied: .denied
            default: .notAsked
            }
        location =
            switch locationManager.authorizationStatus {
            case .authorizedAlways where locationManager.accuracyAuthorization == .fullAccuracy: .allowed
            case .authorizedAlways: .limited("Approximate only")
            // Fixes only while the app is open: most conversations get no place.
            case .authorizedWhenInUse: .limited("Only while using the app")
            case .denied: .denied
            case .restricted: .restricted
            default: .notAsked
            }
    }

    /// His Allow: iOS asks; the row then shows the answer, or why iOS never asked.
    func ask(_ kind: Kind) async {
        await RowState.tap(
            Binding {
                self.asks[kind] ?? .known
            } set: {
                self.asks[kind] = $0
            }
        ) { await answer(kind) }
    }

    private func answer(_ kind: Kind) async -> RowState {
        do {
            #if DEBUG
                if LifeFixture.refuses(kind.rawValue) { throw URLError(.cannotLoadFromNetwork) }
            #endif
            switch kind {
            case .notifications:
                _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            case .location:
                locationManager.requestAlwaysAuthorization()
                // ponytail: polls iOS's answer for a minute; a delegate if the 0.3 s step ever shows.
                for _ in 0..<200 where locationManager.authorizationStatus == .notDetermined {
                    try await Task.sleep(for: .milliseconds(300))
                }
            case .appleHealth: try await AppleHealthReader.claim()
            }
        } catch {
            _ = report(error)
            return .refused("iOS didn't ask. Try again, or allow it in iOS Settings.")
        }
        await refresh()
        return switch kind == .notifications ? notifications : kind == .location ? location : appleHealth {
        case .allowed, .limited: .done("Allowed")
        case .asked: .done("Asked")
        // His No shows as the row's own Off; no answer yet is not a failure of his.
        case .denied, .restricted, .notAsked: .known
        }
    }
}
