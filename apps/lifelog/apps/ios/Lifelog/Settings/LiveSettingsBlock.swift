import LifeConnector
import SwiftUI

/// Life's settings block (`LifeBlock.settings`): the phone's own settings that act in place, a switch with its tick for
/// a second. Only real settings are listed (a key this phone doesn't have is left out); `aura`, the halo settings, only
/// when named. An `offer` is one more switch, off, whose tap says the question's words to Life, and which shows on once said.
struct LiveSettingsBlock: View {
    var keys: [String]?
    var offer: LifeBlock.Offer?
    /// Says the words to Life; whether it went.
    var say: (String) -> Bool = { _ in false }
    var openSettings: () -> Void = {}
    @State private var ticked: String?
    @State private var isOffered = false
    @AppStorage(AppGroup.Key.asksFaceIDToSend, store: AppGroup.defaults) private var asksFaceID = false

    private static let known = ["faceid", "appear", "pair"]

    private var shown: [String] { keys?.filter((Self.known + ["aura"]).contains) ?? Self.known }

    var body: some View {
        SettingsBlock {
            ForEach(Array(shown.enumerated()), id: \.element) { index, key in
                if index > 0 { Hairline() }
                row(key)
            }
            if let offer {
                SettingSwitchRow(title: offer.label, isOn: isOffered, isTicked: ticked == offer.key) { _ in
                    isOffered = say(offer.label)
                    if isOffered { tick(offer.key) }
                }
            }
        }
    }

    @ViewBuilder private func row(_ key: String) -> some View {
        switch key {
        case "faceid":
            SettingSwitchRow(title: "Face ID before Send", isOn: asksFaceID) { asksFaceID = $0 }
                .accessibilityIdentifier("settings.switch.faceIDToSend")
        case "appear":
            AppearanceRow()
        case "aura":
            AuraBlock()
        default:
            Button(action: openSettings) { Row(title: "Pair again with your Mac") { RoundChevron() } }
                .buttonStyle(.plain)
        }
    }

    private func tick(_ key: String) {
        ticked = key
        Task {
            try? await Task.sleep(for: .seconds(1))
            if ticked == key { ticked = nil }
        }
    }
}
