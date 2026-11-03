import Incidents
import Library
import OwnerSettings
import PendantProtocol
import ServerAPI
import SwiftUI

/// Settings, pushed from the gear on the Pendant screen: the processing switches and the vocabulary, alerts, the Lock
/// Screen, the light, spending and your data.
///
/// A push rather than a sheet: it has pages of its own (Light guide, Backup, Server), which push in the same
/// stack with the usual back swipe, and the Spending sheet opens over it without stacking sheets.
struct SettingsView: View {
    let permissions: PermissionsStore
    let allowNotifications: () -> Void

    @Environment(SyncStore.self) private var sync
    @Environment(CaptureStore.self) private var capture
    @Bindable private var settings = Settings.shared
    @State private var showsSpending = false

    /// The address as typed; empty clears it.
    private var copilotAddress: Binding<String> {
        Binding(
            get: { settings.copilotAddress?.absoluteString ?? "" },
            set: { settings.copilotAddress = URL(string: $0.trimmingCharacters(in: .whitespaces)) }
        )
    }

    var body: some View {
        let switches = sync.switches
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                SettingsGroup("Processing", footer: switchesWaiting ? "Waiting to sync." : nil) {
                    SwitchToggle(
                        title: "Transcription",
                        detail:
                            "Sends uploaded audio to ElevenLabs and voices for speaker recognition. Off, it waits on the server; recording and sync go on.",
                        isOn: switches?.transcription
                    ) { on in set(.switches(transcription: on, ai: nil, engine: nil)) }
                    .accessibilityIdentifier("settings.switch.transcription")
                    SwitchToggle(
                        title: "Summaries",
                        detail:
                            "Summaries and titles on your Mac, off by default: Life reads the words themselves. Search works either way.",
                        isOn: switches?.ai
                    ) { on in set(.switches(transcription: nil, ai: on, engine: nil)) }
                    .accessibilityIdentifier("settings.switch.ai")
                    EnginePicker(engine: switches?.engine) { engine in
                        set(.switches(transcription: nil, ai: nil, engine: engine))
                    }
                    NavigationLink {
                        VocabularyView()
                    } label: {
                        SettingsLink("Vocabulary")
                    }
                    .accessibilityIdentifier("settings.vocabulary")
                }
                SettingsGroup(
                    "Copilot",
                    footer:
                        "While on, what your Pendant hears goes from this phone to ElevenLabs as it's said, and its words to your copilot. A press asks it to speak now in your AirPods; a press while it speaks stops it."
                ) {
                    Toggle("Copilot", isOn: $settings.copilotOn)
                        .accessibilityIdentifier("settings.copilot")
                    TextField("Copilot address", text: copilotAddress)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("settings.copilotAddress")
                }
                SettingsGroup(
                    "Alerts",
                    footer:
                        "You're always told when recording is paused or resumed on the Pendant itself, or when it hasn't answered for more than \(Int(PendantChangeReducer.disconnectAfter / 60)) minutes. Never for what you do here. While the Pendant records, you're also asked to open the app when its audio has waited on the phone for the time below."
                ) {
                    Toggle("Low-battery alert", isOn: $settings.alerts.lowBattery)
                        .accessibilityIdentifier("pendant.settings.lowBattery")
                    if settings.alerts.lowBattery {
                        Stepper(value: $settings.alerts.lowBatteryPercent, in: 5...50, step: 5) {
                            HStack {
                                Text("Alert below")
                                Spacer()
                                Text(settings.alerts.lowBatteryPercent.formatted(.percent)).font(.monoTime)
                                    .foregroundStyle(
                                        Palette.textBody)
                            }
                        }
                        .accessibilityValue("\(settings.alerts.lowBatteryPercent) percent")
                        .accessibilityIdentifier("pendant.settings.lowBatteryPercent")
                    }
                    Toggle("Low-storage alert", isOn: $settings.alerts.lowPendantStorage)
                        .accessibilityIdentifier("pendant.settings.lowStorage")
                    OpenAppPicker(minutes: switches?.openAppAfterMinutes) {
                        set(.switches(openAppAfterMinutes: $0))
                    }
                    PermissionRow(
                        name: "Notifications", state: permissions.notifications,
                        explanation: "How alerts reach you.",
                        ask: allowNotifications)
                }
                // The Limitless Pendant's light; an Omi has no command for it.
                if CaptureStore.pairedKind != .omi {
                    SettingsGroup("Light") {
                        LightBrightnessRow(isConnected: isConnected, set: capture.setLightBrightness)
                        NavigationLink {
                            LightGuideView()
                        } label: {
                            SettingsLink("Light guide")
                        }
                        .accessibilityIdentifier("pendant.settings.lightGuide")
                    }
                }
                SettingsGroup("Spending") {
                    Button {
                        showsSpending = true
                    } label: {
                        SettingsLink("Spending")
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("pendant.settings.spending")
                }
                .sheet(isPresented: $showsSpending) {
                    SpendingSheet()
                }
                SettingsGroup("Your data") {
                    PermissionRow(
                        name: "Location", state: permissions.location,
                        explanation:
                            "Notes where you were every five minutes while the Pendant records, so each conversation shows its place. Always lets it work with the app closed.",
                        ask: permissions.askLocation)
                    NavigationLink {
                        BackupView()
                    } label: {
                        SettingsLink("Backup & restore")
                    }
                    .accessibilityIdentifier("pendant.settings.backup")
                    NavigationLink {
                        PairingView(server: sync.server) { sync.offeredPairing = $0 }
                    } label: {
                        SettingsLink("Server", value: sync.server?.host() ?? "Not paired")
                    }
                    .accessibilityIdentifier("pendant.settings.server")
                    #if DEBUG
                        NavigationLink {
                            DiagnosticsView()
                        } label: {
                            SettingsLink("Diagnostics")
                        }
                        .accessibilityIdentifier("pendant.settings.diagnostics")
                    #endif
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .tint(Palette.redFill)
        .background(Palette.ground)
        .navigationTitle("Settings")
        .toolbarTitleDisplayMode(.inlineLarge)
    }

    private var switchesWaiting: Bool {
        sync.pending.waiting.contains { if case .switches = $0.intent { true } else { false } }
    }

    private func set(_ intent: OwnerIntent) { Task { await sync.perform(intent) } }

    private var isConnected: Bool {
        if case .ready = capture.shown.connection { true } else { false }
    }
}

/// A titled group of rows on one surface, rows split by hairlines.
private struct SettingsGroup<Content: View>: View {
    let title: String
    let footer: String?
    let content: Content

    init(_ title: String, footer: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.textSecondary)
                .accessibilityAddTraits(.isHeader)
                .padding(.horizontal, 16)
            VStack(spacing: 0) {
                Group(subviews: content) { rows in
                    ForEach(rows) { row in
                        row
                            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                            .padding(.horizontal, 16)
                            .overlay(alignment: .top) {
                                if row.id != rows.first?.id {
                                    Hairline()
                                }
                            }
                    }
                }
            }
            .foregroundStyle(Palette.textPrimary)
            .card(radius: Metrics.Radius.group)
            if let footer {
                Text(footer)
                    .font(.footnote)
                    .foregroundStyle(Palette.textTertiary)
                    .padding(.horizontal, 16)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.bottom, 24)
    }
}

/// A row that opens a page: its name, an optional value, a chevron.
private struct SettingsLink: View {
    let title: String
    var value: String?

    init(_ title: String, value: String? = nil) {
        self.title = title
        self.value = value
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(title).foregroundStyle(Palette.textPrimary)
            Spacer(minLength: 8)
            if let value { Text(value).foregroundStyle(Palette.textSecondary) }
            Image(systemName: "chevron.forward")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.textTertiary)
                .accessibilityHidden(true)
        }
        .frame(minHeight: 52)
        .contentShape(.rect)
    }
}

/// The server this iPhone is paired with, and a pasted pairing link (confirmed on screen, never shown back).
struct PairingView: View {
    let server: URL?
    /// Asks to pair, confirmed on screen (`RootView`).
    let offer: (Pairing) -> Void

    @State private var draft = ""
    @State private var result: String?

    var body: some View {
        Form {
            Section {
                Label(
                    server.map { "Paired with \($0.host() ?? $0.absoluteString)" } ?? "Not paired",
                    systemImage: server == nil ? "link.badge.plus" : "link")
                TextField("Pairing link", text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button(server == nil ? "Pair" : "Pair again") {
                    let link = URL(string: draft.trimmingCharacters(in: .whitespacesAndNewlines))
                    if let pairing = link.flatMap(Pairing.init(link:)) {
                        offer(pairing)
                        result = nil
                    } else {
                        result = "That isn't a pairing link."
                    }
                    draft = ""
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let result { Text(result) }
            } footer: {
                Text(
                    "Scan the pairing code on your Mac with the Camera, or paste its link here. The token stays in this iPhone's Keychain and is never shown again."
                )
            }
        }
        .scrollContentBackground(.hidden)
        .background(Palette.ground)
        .navigationTitle("Server")
    }
}

#if DEBUG
    #Preview("Server") {
        NavigationStack { PairingView(server: URL(string: "https://mac.example.ts.net")) { _ in } }
            .preferredColorScheme(.dark)
    }
#endif

extension SyncStore {
    /// The owner's switches as every screen shows them: the feed's, with a change waiting in the outbox applied. A
    /// change the server refused rolls back with it.
    var switches: ServerClient.Switches? { pending.switches(over: feed.switches) }
}

/// One of the owner's processing switches, held by the server: disabled until its state is known. A change goes
/// through the outbox like any edit and shows at once.
private struct SwitchToggle: View {
    let title: String
    let detail: String
    let isOn: Bool?
    let set: (Bool) -> Void

    var body: some View {
        Toggle(isOn: Binding(get: { isOn ?? false }, set: { set($0) })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Palette.textTertiary)
            }
        }
        .disabled(isOn == nil)
    }
}

/// How long the Pendant's audio may wait on the phone, while it records, before the server asks him to open the app. The
/// server holds it, like the switches: disabled until the feed said.
private struct OpenAppPicker: View {
    let minutes: Int?
    let set: (Int) -> Void

    var body: some View {
        Picker("Ask me to open the app", selection: Binding(get: { minutes ?? 0 }, set: set)) {
            Text("Off").tag(0)
            ForEach([10, 15, 30, 60], id: \.self) { Text("After \($0) min").tag($0) }
        }
        .disabled(minutes == nil)
        .accessibilityIdentifier("settings.openAppAfter")
    }
}

private struct EnginePicker: View {
    let engine: ServerClient.Switches.Engine?
    let set: (ServerClient.Switches.Engine) -> Void

    var body: some View {
        Picker(
            "AI model",
            selection: Binding(
                get: { engine ?? .unknown },
                set: { selected in
                    guard selected != .unknown, selected != engine else { return }
                    set(selected)
                })
        ) {
            Text("Claude").tag(ServerClient.Switches.Engine.claude)
            Text("ChatGPT").tag(ServerClient.Switches.Engine.codex)
            if engine == nil || engine == .unknown {
                Text("Unavailable").tag(ServerClient.Switches.Engine.unknown)
            }
        }
        .disabled(engine == nil || engine == .unknown)
        .accessibilityIdentifier("settings.switch.engine")
    }
}
