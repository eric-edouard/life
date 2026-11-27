import SwiftUI

/// The Face ID before Send setting: one switch, the same in Settings and in a settings block in the thread.
struct FaceIDRow: View {
    @AppStorage(AppGroup.Key.asksFaceIDToSend, store: AppGroup.defaults) private var asksFaceID = false

    var body: some View {
        SettingSwitchRow(title: "Face ID before Send", isOn: asksFaceID) { asksFaceID = $0 }
            .accessibilityIdentifier("settings.switch.faceIDToSend")
    }
}
