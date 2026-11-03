import Foundation
import Incidents
import Observation

/// The owner's choices, in one place. Each is read once and written through on every change, under the key it has
/// always had: a renamed key would quietly lose the owner's setting, so the keys never change.
@MainActor
@Observable
public final class Settings {
    /// The Pendant light's brightness last sent, out of 100; nil until the owner picks one (it's never read back).
    public var lightBrightnessLevel: Int? {
        didSet { defaults.set(lightBrightnessLevel, forKey: Key.lightBrightnessLevel) }
    }
    public var lightBrightnessCheck: LightBrightnessCheck {
        didSet { defaults.set(lightBrightnessCheck.rawValue, forKey: Key.lightBrightnessCheck) }
    }
    /// The Pendant screen's "Allow notifications" card, closed for good.
    public var notificationsInviteDismissed: Bool {
        didSet { defaults.set(notificationsInviteDismissed, forKey: Key.notificationsInviteDismissed) }
    }
    /// The Copilot (docs/pendant.md): while on, what the Pendant hears streams to Scribe and a press asks the copilot.
    public var copilotOn: Bool {
        didSet { defaults.set(copilotOn, forKey: Key.copilotOn) }
    }
    /// The copilot's address: a project's copilot server on the owner's Mac, over Tailscale. `nil` until he sets one.
    public var copilotAddress: URL? {
        didSet { defaults.set(copilotAddress?.absoluteString, forKey: Key.copilotAddress) }
    }
    /// In the app group for historical reasons; only the app reads it.
    public var alerts: AlertSettings {
        didSet { group.set(try? JSONEncoder().encode(alerts), forKey: Key.alerts) }
    }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let group: UserDefaults

    /// `group` is the app group's defaults.
    public init(defaults: UserDefaults, group: UserDefaults) {
        self.defaults = defaults
        self.group = group
        lightBrightnessLevel = defaults.object(forKey: Key.lightBrightnessLevel) as? Int
        lightBrightnessCheck =
            defaults.string(forKey: Key.lightBrightnessCheck).flatMap(LightBrightnessCheck.init) ?? .unasked
        notificationsInviteDismissed = defaults.bool(forKey: Key.notificationsInviteDismissed)
        copilotOn = defaults.bool(forKey: Key.copilotOn)
        copilotAddress = defaults.string(forKey: Key.copilotAddress).flatMap(URL.init(string:))
        alerts =
            group.data(forKey: Key.alerts).flatMap { try? JSONDecoder().decode(AlertSettings.self, from: $0) }
            ?? AlertSettings()
    }

    /// Never rename one: each holds a value the owner already chose.
    private enum Key {
        static let lightBrightnessLevel = "lightBrightnessLevel"
        static let lightBrightnessCheck = "lightBrightnessCheck"
        static let notificationsInviteDismissed = "notificationsInviteDismissed"
        static let alerts = "alertSettings"
        static let copilotOn = "copilotOn"
        static let copilotAddress = "copilotAddress"
    }
}

/// Did changing the brightness visibly change the light? Asked once, after the first change, because nothing on the
/// firmware confirms the command (docs/pendant.md).
public enum LightBrightnessCheck: String, Sendable {
    case unasked
    case changed = "dimmed"
    case unchanged
}
