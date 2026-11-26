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

    private static let known = ["faceid", "pair"]

    private var shown: [String] { keys?.filter((Self.known + ["aura"]).contains) ?? Self.known }

    var body: some View {
        SettingsBlock {
            ForEach(Array(shown.enumerated()), id: \.element) { index, key in
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
            FaceIDRow()
        case "aura":
            AuraBlock()
        default:
            Button(action: openSettings) { Row(title: "Pair again with your Mac") { RowValue() } }
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
