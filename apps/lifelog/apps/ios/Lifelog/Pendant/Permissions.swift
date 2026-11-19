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

    private(set) var notifications = Access.allowed
    private(set) var location = Access.allowed
    private(set) var appleHealth = Access.notAsked
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

    func askLocation() {
        locationManager.requestAlwaysAuthorization()
    }

    func askAppleHealth() async {
        do {
            try await AppleHealthReader.claim()
            await refresh()
        } catch { _ = report(error) }
    }
}
