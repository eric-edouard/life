import SwiftUI

/// The Face ID before Send setting: one row, in Settings.
struct FaceIDRow: View {
    @AppStorage(AppGroup.Key.asksFaceIDToSend, store: AppGroup.defaults) private var asksFaceID = false

    var body: some View {
        Row(
            title: "Face ID before Send", icon: "faceid",
            detail: asksFaceID
                ? "Send from a notification waits for Face ID, on the phone only"
                : "Send from a notification, on the phone or the Watch"
        ) {
            RowSwitch(title: "Face ID before Send", isOn: asksFaceID) { asksFaceID = $0 }
        }
        .accessibilityIdentifier("settings.switch.faceIDToSend")
    }
}
