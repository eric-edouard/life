import Incidents
import SwiftUI
import WidgetKit

/// Control Center (and Action button) toggle. Its value is the Pendant's reported state; while a request waits for
/// the Pendant it says so instead of pretending the change happened.
struct RecordingControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "RecordingControl", provider: Provider()) { value in
            ControlWidgetToggle("Recording", isOn: value.isOn, action: SetRecordingIntent()) { _ in
                Label(value.label, systemImage: value.symbol)
            }
            .tint(Palette.liveDot)
        }
        .displayName("Pendant Recording")
        .description("Shows and toggles recording on your Pendant.")
    }

    nonisolated struct Value {
        var isOn: Bool
        var label: String
        var symbol: String
    }

    nonisolated struct Provider: ControlValueProvider {
        var previewValue: Value { Value(isOn: true, label: "Recording", symbol: "record.circle.fill") }

        func currentValue() async throws -> Value {
            let now = Date.now
            let snapshot = PendantSnapshot.load() ?? PendantSnapshot(link: .notConnected)
            // On for a last-known recording, as the app's Pause button offers then, so a tap pauses; the label
            // and symbol say how much is known.
            let isOn =
                snapshot.pendingRequest(now: now).map { $0 == .resume }
                ?? (snapshot.recording(now: now).microphone == .recording)
            return Value(isOn: isOn, label: snapshot.headline(now: now), symbol: snapshot.symbol(now: now))
        }
    }
}
