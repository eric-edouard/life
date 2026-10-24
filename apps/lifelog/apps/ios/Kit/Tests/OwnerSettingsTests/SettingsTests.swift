import Foundation
import Incidents
import OwnerSettings
import Testing

@MainActor
struct SettingsTests {
    private let defaults = UserDefaults(suiteName: "settings-tests-\(UUID())")!
    private let group = UserDefaults(suiteName: "settings-tests-group-\(UUID())")!

    /// Written the way the app wrote them before the store (`@AppStorage`, `UserDefaults.set`, JSON in the app group),
    /// under the same keys: the owner's choices must survive the update.
    @Test func existingValuesLoad() throws {
        defaults.set(40, forKey: "lightBrightnessLevel")
        defaults.set("dimmed", forKey: "lightBrightnessCheck")
        defaults.set(true, forKey: "notificationsInviteDismissed")
        var alerts = AlertSettings()
        alerts.lowBattery = false
        alerts.lowBatteryPercent = 35
        group.set(try JSONEncoder().encode(alerts), forKey: "alertSettings")

        let settings = Settings(defaults: defaults, group: group)
        #expect(settings.lightBrightnessLevel == 40)
        #expect(settings.lightBrightnessCheck == .changed)
        #expect(settings.notificationsInviteDismissed)
        #expect(settings.alerts == alerts)
    }

    @Test func defaultsBeforeAnyChoice() {
        let settings = Settings(defaults: defaults, group: group)
        #expect(settings.lightBrightnessLevel == nil)
        #expect(settings.lightBrightnessCheck == .unasked)
        #expect(!settings.notificationsInviteDismissed)
        #expect(settings.alerts == AlertSettings())
    }

    @Test func changesSurviveARelaunch() {
        let settings = Settings(defaults: defaults, group: group)
        settings.lightBrightnessLevel = 10
        settings.lightBrightnessCheck = .unchanged
        settings.notificationsInviteDismissed = true
        settings.alerts.lowBatteryPercent = 15

        let relaunched = Settings(defaults: defaults, group: group)
        #expect(relaunched.lightBrightnessLevel == 10)
        #expect(relaunched.lightBrightnessCheck == .unchanged)
        #expect(relaunched.notificationsInviteDismissed)
        #expect(relaunched.alerts.lowBatteryPercent == 15)
    }
}
