import Capture
import SwiftUI

/// What works, in one place: both connections as their pages say it, the Pendant, the audio waiting on the phone. "Run
/// all checks" is every connection's "Check now"; "Copy report" puts the same lines on the clipboard, with no token and
/// no address. The debug build adds the raw capture dump below.
struct DiagnosticsView: View {
    @Environment(SyncStore.self) private var sync
    @Environment(LifeStore.self) private var life
    @Environment(CaptureStore.self) private var capture
    @State private var isChecking = false
    @State private var copied = false

    private var rows: [(title: String, mark: StateMark)] {
        var rows: [(String, StateMark)] = [
            ("Life answers", isChecking ? LinkState.checking.mark : life.link.mark),
            ("Pendant server answers", isChecking ? LinkState.checking.mark : sync.summary.state.link.mark),
        ]
        let isConnected = if case .ready = capture.shown.connection { true } else { false }
        rows.append(("Pendant connected", StateMark(glyph: isConnected ? .ok : .off, word: isConnected ? "Yes" : "No")))
        if let uploads = sync.uploads {
            rows.append(
                (
                    "Uploads",
                    StateMark(
                        glyph: uploads.lastError == nil ? .ok : .flag,
                        word: uploads.lastError == nil ? "Fine" : "Failing")
                ))
            rows.append(
                (
                    "Audio waiting on the phone",
                    StateMark(
                        glyph: .off,
                        word: uploads.unsent > .zero ? DurationText.string(uploads.unsent, width: .wide) : "None")
                ))
        }
        return rows
    }

    private var version: String { "Life \(Bundle.main.versionWords) · iOS \(UIDevice.current.systemVersion)" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                RowGroup(surface: .sheet) {
                    ForEach(rows, id: \.title) { row in Row(title: row.title) { row.mark } }
                }
                VStack(spacing: 10) {
                    Button("Run all checks") { Task { await runAll() } }
                        .buttonStyle(.pill(.filled, isBusy: isChecking))
                    Button(copied ? "Copied" : "Copy report") {
                        UIPasteboard.general.string = ([version] + rows.map { "\($0.title): \($0.mark.word)" }).joined(
                            separator: "\n")
                        copied = true
                    }
                    .buttonStyle(.pill(.quiet))
                }
                Text(version).font(.note).foregroundStyle(Palette.muted)
                #if DEBUG
                    NavigationLink("Capture dump") { CaptureDump() }.font(.note).foregroundStyle(Palette.muted)
                #endif
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 8)
            .padding(.bottom, 24)
            .readingWidth()
        }
        .background(Palette.sheet)
        .navigationTitle("Diagnostics")
    }

    private func runAll() async {
        isChecking = true
        copied = false
        async let a: Void = life.refreshInbox()
        async let b: Void = sync.checkNow()
        _ = await (a, b)
        isChecking = false
    }
}

#if DEBUG
    /// Debug-only wiring check: raw capture status, the intents, and the simulated Pendant; no styling on purpose.
    private struct CaptureDump: View {
        var body: some View {
            List {
                StatusSection()
                IntentsSection()
                WakesSection()
                FakeSection()
            }
            .navigationTitle("Capture dump")
        }
    }

    private struct StatusSection: View {
        @Environment(CaptureStore.self) private var capture

        var body: some View {
            let status = capture.status
            Section("Status") {
                LabeledContent("Availability", value: String(describing: capture.availability))
                LabeledContent("Connection", value: String(describing: status.connection))
                LabeledContent("Recording", value: String(describing: status.recording))
                LabeledContent("Last known recording", value: describe(status.lastKnownRecording))
                LabeledContent("Sync", value: String(describing: status.sync))
                LabeledContent("Backlog", value: describe(status.backlog))
                LabeledContent("Battery", value: describe(status.batteryPercent))
                LabeledContent("Charging", value: describe(status.charging))
                LabeledContent("Pendant storage", value: describe(status.storage))
                LabeledContent("Last contact", value: describe(status.lastContact))
                LabeledContent("Last button", value: describe(status.lastButton))
                LabeledContent("Last ACK", value: status.lastAcknowledgedIndex.map(String.init) ?? "none")
                LabeledContent("Incidents", value: status.incidents.map { "\($0)" }.sorted().joined(separator: ", "))
                LabeledContent(
                    "Phone free",
                    value: capture.phoneFreeBytes.map { $0.formatted(.byteCount(style: .file)) } ?? "unknown")
            }
        }

        private func describe<Value>(_ observed: Observed<Value>?) -> String {
            guard let observed else { return "unknown" }
            return "\(observed.value) (\(capture.freshness(of: observed.at)))"
        }

        private func describe(_ date: Date?) -> String {
            guard let date else { return "never" }
            return "\(date.formatted(date: .omitted, time: .standard)) (\(capture.freshness(of: date)))"
        }
    }

    /// The background-wake log for the hardware test. Also in the app container: `capture.wakeLogURL`.
    private struct WakesSection: View {
        @Environment(CaptureStore.self) private var capture

        var body: some View {
            let wakes = capture.wakeLog.wakes
            Section("Background wakes") {
                LabeledContent("Wakes logged", value: "\(wakes.count)")
                LabeledContent("File", value: capture.wakeLogURL.path(percentEncoded: false))
                ForEach(wakes.indices.reversed().prefix(30), id: \.self) { index in
                    let wake = wakes[index]
                    let seconds = wake.end.timeIntervalSince(wake.start)
                    LabeledContent(
                        wake.start.formatted(date: .abbreviated, time: .standard),
                        value: "\(seconds.formatted(.number.precision(.fractionLength(1)))) s · "
                            + "\(wake.saved.pushed) pushed, \(wake.saved.pulled) pulled, \(wake.saved.duplicates) dup · "
                            + wake.saved.bytes.formatted(.byteCount(style: .file)))
                }
            }
        }
    }

    private struct IntentsSection: View {
        @Environment(CaptureStore.self) private var capture

        var body: some View {
            Section("Intents") {
                Button("Pause recording") { Task { await capture.pause() } }
                Button("Resume recording") { Task { await capture.resume() } }
                Button("Sync now") { Task { await capture.syncNow() } }
                Button("Reconnect") { Task { await capture.reconnect() } }
                // In 3 s, time to go to the screen to see it on.
                if let fake = capture.fake {
                    Button("Press once in 3 s") {
                        Task {
                            try? await Task.sleep(for: .seconds(3)); await fake.pressButton()
                        }
                    }
                }
            }
        }
    }

    private struct FakeSection: View {
        @Environment(CaptureStore.self) private var capture
        @State private var scenario: FakeScenario?

        var body: some View {
            Section("Simulated Pendant") {
                Picker("Scenario", selection: $scenario) {
                    Text("Real Pendant").tag(FakeScenario?.none)
                    ForEach(FakeScenario.allCases) { Text($0.rawValue).tag(Optional($0)) }
                }
                .onAppear { scenario = capture.scenario }
                // There is no going back to the real Pendant without a relaunch.
                .onChange(of: scenario) { _, new in
                    if let new, new != capture.scenario { capture.use(new) }
                }
                if let fake = capture.fake {
                    Button("Hold button (toggle recording)") { Task { await fake.longPress() } }
                    Button("Record 100 pages") { Task { await fake.record(pages: 100) } }
                }
            }
        }
    }
#endif
