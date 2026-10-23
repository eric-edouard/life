import CoreLocation
import Observation
import SwiftUI
import UserNotifications

/// Notifications and location, the two permissions the owner grants from here. Bluetooth's states show in the status
/// sentence. Read fresh whenever the screen comes forward.
@Observable
final class PermissionsStore {
    enum Access: Equatable {
        case allowed
        case limited(String)
        case notAsked
        case denied
        case restricted
    }

    private(set) var notifications = Access.allowed
    private(set) var location = Access.allowed
    /// Kept alive so its authorization prompt stays up.
    @ObservationIgnored private let locationManager = CLLocationManager()

    init(notifications: Access = .allowed, location: Access = .allowed) {
        self.notifications = notifications
        self.location = location
    }

    func refresh() async {
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
}

/// One permission on one compact row: its state, the one thing to do about it, and why Life wants it.
struct PermissionRow: View {
    let name: String
    let state: PermissionsStore.Access
    let explanation: String
    let ask: () -> Void

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).foregroundStyle(Palette.textPrimary)
                        .accessibilityIdentifier(identifier)
                    Text(status).font(.footnote).foregroundStyle(Palette.textSecondary)
                }
                Spacer(minLength: 8)
                switch state {
                case .allowed:
                    EmptyView()
                case .notAsked:
                    Button("Allow", action: ask).buttonStyle(.glass)
                        .accessibilityIdentifier("\(identifier).allow")
                case .limited, .denied, .restricted:
                    Button("Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                    .buttonStyle(.glass)
                    .accessibilityLabel("Open Settings for \(name)")
                    .accessibilityIdentifier("\(identifier).settings")
                }
            }
            Text(explanation)
                .font(.caption)
                .foregroundStyle(Palette.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 10)
    }

    /// "pendant.settings.location"
    private var identifier: String { "pendant.settings.\(name.lowercased())" }

    private var status: String {
        switch state {
        case .allowed: "Allowed"
        case .limited(let detail): detail
        case .notAsked: "Not asked yet"
        case .denied: "Off"
        case .restricted: "Restricted"
        }
    }
}
