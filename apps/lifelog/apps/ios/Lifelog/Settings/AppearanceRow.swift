import SwiftUI

/// The phone's own light or dark choice, kept on the phone (never sent): Auto follows the system.
enum Appearance: String, CaseIterable {
    case auto = "Auto", dark = "Dark", light = "Light"

    static let key = "appearance"

    var scheme: ColorScheme? {
        switch self {
        case .auto: nil
        case .dark: .dark
        case .light: .light
        }
    }
}

/// Appearance: Auto, Dark or Light as one row of pills; `RootView` applies it with `preferredColorScheme`.
struct AppearanceRow: View {
    @AppStorage(Appearance.key) private var appearance = Appearance.auto

    var body: some View {
        SettingValueRow(
            title: "Appearance", choices: Appearance.allCases.map(\.rawValue), selection: appearance.rawValue
        ) { appearance = Appearance(rawValue: $0) ?? .auto }
    }
}
