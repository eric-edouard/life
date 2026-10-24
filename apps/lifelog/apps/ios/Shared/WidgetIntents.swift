import AppIntents
import WidgetKit

// Compiled into the widget extension so the control can name them, but they only ever run in the app, which holds
// the Bluetooth link to the Pendant (`allowedExecutionTargets`).

/// The Recording control's action. It goes through `CaptureStore.request`, like Shortcuts.
struct SetRecordingIntent: SetValueIntent {
    static let title: LocalizedStringResource = "Pendant Recording"
    static let description = IntentDescription("Pauses or resumes recording on your Pendant.")
    static var allowedExecutionTargets: IntentExecutionTargets { .main }
    /// Never brings the app forward: that is what lets watchOS offer this control on the Watch (Control Center,
    /// Smart Stack, Action button), where a tap runs it here on the iPhone.
    static var supportedModes: IntentModes { .background }

    @Parameter(title: "Recording") var value: Bool

    init() {}

    /// For a button that asks for one state.
    init(value: Bool) {
        self.value = value
    }

    #if !WIDGET_EXTENSION
        @Dependency private var capture: CaptureStore
    #endif

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
            // The control shows pending, then the confirmed state, from what the app publishes meanwhile.
            _ = await capture.request(value ? .resume : .pause)
            // Whatever happened, show the Pendant's state rather than the optimistic flip.
            ControlCenter.shared.reloadAllControls()
        #endif
        return .result()
    }
}
