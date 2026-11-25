import LifeConnector
import SwiftUI

/// Life's settings block (`LifeBlock.settings`): the phone's own settings that act in place, a switch with its tick for
/// a second. Only real settings are listed (a key this phone doesn't have is left out); an `offer` is one more switch,
/// off, whose tap says the question's words to Life, and which shows on once said.
struct LiveSettingsBlock: View {
    var keys: [String]?
    var offer: LifeBlock.Offer?
    var say: (String) -> Void = { _ in }
    var openSettings: () -> Void = {}
    @AppStorage(AppGroup.Key.asksFaceIDToSend, store: AppGroup.defaults) private var asksFaceID = false
    @State private var ticked: String?
    @State private var isOffered = false

    private static let known = ["faceid", "pair"]

    private var shown: [String] { (keys ?? Self.known).filter(Self.known.contains) }

    var body: some View {
        SettingsBlock {
            ForEach(Array(shown.enumerated()), id: \.element) { index, key in
                if index > 0 { Hairline() }
                row(key)
            }
            if let offer {
                if !shown.isEmpty { Hairline() }
                SettingSwitchRow(title: offer.label, isOn: isOffered, isTicked: ticked == offer.key) { _ in
                    isOffered = true
                    say(offer.label)
                    tick(offer.key)
                }
            }
        }
    }

    @ViewBuilder private func row(_ key: String) -> some View {
        switch key {
        case "faceid":
            SettingSwitchRow(title: "Face ID before Send", isOn: asksFaceID, isTicked: ticked == key) {
                asksFaceID = $0
                tick(key)
            }
        default:
            Button(action: openSettings) {
                HStack {
                    Text("Pair again with your Mac").font(.rowTitle)
                    Spacer(minLength: 0)
                    RowValue()
                }
                .frame(minHeight: Metrics.tapTarget + Metrics.Spacing.s).contentShape(.rect)
            }
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
