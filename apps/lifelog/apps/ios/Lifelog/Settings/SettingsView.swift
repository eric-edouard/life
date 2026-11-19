import Incidents
import Library
import LifeConnector
import OwnerSettings
import PendantProtocol
import ServerAPI
import SwiftUI

/// Settings, the sheet over the app, in the order of what breaks the app: what needs him, the two connections, what this
/// phone allows, the Pendant, appearance, his data, help. It has pages of its own (Vocabulary, Light guide, Backup,
/// pairing), which push in the sheet's own stack. Drawn only with `Row` and `RowGroup`.
struct SettingsView: View {
    let permissions: PermissionsStore
    let allowNotifications: () -> Void
    let close: () -> Void

    @Environment(SyncStore.self) private var sync
    @Environment(CaptureStore.self) private var capture
    @Environment(AppleHealthReader.self) private var appleHealth
    @Environment(LifeStore.self) private var life
    @Environment(\.openURL) private var openURL
    @AppStorage("appearance") private var appearance = Appearance.auto
    @Bindable private var settings = Settings.shared
    @State private var pairing: PairingTarget?

    private enum PairingTarget: Hashable { case life, server }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                SheetHeader(title: "Settings", close: close)
                needsYou
                connections
                allows
                pendant
                RowGroup(label: "Appearance", surface: .sheet) {
                    SegmentedChoice(
                        choices: [Appearance.auto, .light, .dark],
                        selection: Binding(get: { appearance }, set: { appearance = $0 ?? appearance }),
                        title: { $0.rawValue.capitalized }
                    )
                    .padding(8)
                    .accessibilityIdentifier("settings.appearance")
                }
                yourData
                help
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 16)
            .padding(.bottom, 24)
            .readingWidth()
        }
        .tint(Palette.fg)
        .background(Palette.sheet)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(item: $pairing) { target in
            switch target {
            case .life:
                PairingView(
                    title: "Life", paired: life.pairedOrigin.map(\.hostWords), note: life.pairingNote,
                    accepts: { LifePairing(link: $0) != nil })
            case .server:
                PairingView(
                    title: "Server", paired: sync.server?.hostWords, note: nil,
                    accepts: { Pairing(link: $0) != nil })
            }
        }
    }

    // MARK: Needs you

    /// What needs him, each with its one button; the group is absent when nothing does.
    @ViewBuilder private var needsYou: some View {
        let notifications = permissions.notifications
        let needsNotifications = notifications == .notAsked || notifications == .denied || notifications == .restricted
        if life.link == .notPaired || life.link == .noAnswer || sync.summary.state.link == .notPaired
            || sync.summary.state.link == .noAnswer || needsNotifications
        {
            RowGroup(label: "Needs you", labelColor: Palette.flag, surface: .sheet) {
                switch life.link {
                case .notPaired:
                    Row(title: "Life is not paired", detail: "Pair it with the link on your Mac.") {
                        RowButton(title: "Pair") { pairing = .life }
                    }
                case .noAnswer:
                    Row(title: "Life does not answer", detail: lifeSilence) {
                        RowButton(title: "Check", isBusy: life.inbox.phase == .loading) {
                            Task { await life.refreshInbox() }
                        }
                    }
                case .works, .checking: EmptyView()
                }
                switch sync.summary.state.link {
                case .notPaired:
                    Row(title: "Server is not paired", detail: "Recording goes on; nothing is sent.") {
                        RowButton(title: "Pair") { pairing = .server }
                    }
                case .noAnswer:
                    Row(title: "Server does not answer", detail: "Audio waits on this phone.") {
                        RowButton(title: "Check") { sync.run() }
                    }
                case .works, .checking: EmptyView()
                }
                if needsNotifications {
                    Row(title: "Notifications are off", detail: "Cards can't reach you.") {
                        RowButton(title: "Turn on") { allow(notifications, ask: allowNotifications) }
                    }
                }
            }
        }
    }

    private var lifeSilence: String {
        let since = life.inbox.loadedAt.map { "Last read \($0.formatted(date: .omitted, time: .shortened)). " } ?? ""
        return since + "The Mac may be asleep."
    }

    // MARK: Connections

    private var connections: some View {
        RowGroup(label: "Connections", surface: .sheet) {
            Button { pairing = .life } label: {
                Row(title: "Life", detail: life.pairedOrigin?.hostWords) {
                    HStack(spacing: 8) { life.link.mark; RowValue() }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings.life")
            Button { pairing = .server } label: {
                Row(title: "Pendant server", detail: sync.server?.hostWords) {
                    HStack(spacing: 8) { sync.summary.state.link.mark; RowValue() }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("pendant.settings.server")
        }
    }

    // MARK: This phone allows

    private var allows: some View {
        RowGroup(label: "This phone allows", surface: .sheet) {
            permission(
                "Notifications", "Inbox cards reach you", permissions.notifications, ask: allowNotifications)
            permission("Bluetooth", "The pendant", bluetooth, ask: nil)
            permission("Location", "Where things were said", permissions.location, ask: permissions.askLocation)
            if AppleHealthReader.isAvailable {
                permission("Apple Health", "Sleep and workouts", permissions.appleHealth) {
                    Task {
                        await permissions.askAppleHealth()
                        await appleHealth.sync()
                    }
                }
            }
        }
    }

    private var bluetooth: PermissionsStore.Access {
        switch capture.context.bluetoothPermission {
        case .notDetermined: .notAsked
        case .denied: .denied
        case .restricted: .restricted
        case .allowed: .allowed
        }
    }

    /// One permission: on, or the one thing to do. Not asked has a button only when the app can ask from here (Bluetooth's
    /// ask comes with pairing a pendant); refused goes to iOS Settings.
    private func permission(
        _ name: String, _ why: String, _ access: PermissionsStore.Access, ask: (() -> Void)?
    ) -> some View {
        let id = "pendant.settings.\(name.lowercased())"
        return Group {
            switch access {
            case .allowed, .asked:
                Row(title: name, detail: why) { StateMark(glyph: .ok, word: "On") }
            case .notAsked:
                Row(title: name, detail: why) {
                    if let ask { RowButton(title: "Allow", action: ask) } else { StateMark(glyph: .off, word: "Not asked") }
                }
            case .limited(let what):
                Row(title: name, detail: what) { RowButton(title: "Open", action: openSettings) }
            case .denied, .restricted:
                Row(title: name, detail: "Change it in iOS Settings") {
                    StateMark(glyph: .flag, word: "Off")
                    RowButton(title: "Open", action: openSettings)
                }
            }
        }
        .accessibilityIdentifier(id)
    }

    private func allow(_ access: PermissionsStore.Access, ask: () -> Void) {
        if access == .notAsked { ask() } else { openSettings() }
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
    }

    // MARK: Pendant

    private var pendant: some View {
        RowGroup(label: "Pendant", surface: .sheet) {
            ServerRow(title: "Transcription", value: serverValue(.transcription, feed: sync.feed.switches, pending: sync.pending)) {
                RowSwitch(title: "Transcription", isOn: $0) { on in
                    Task { await sync.perform(.switches(transcription: on)) }
                }
            }
            .accessibilityIdentifier("settings.switch.transcription")
            ServerRow(
                title: "Ask me to open the app", detail: "When audio has waited on the phone",
                value: serverValue(.openAppAfterMinutes, feed: sync.feed.switches, pending: sync.pending)
            ) { minutes in
                RowMenu(
                    title: "Ask me to open the app",
                    choices: choices([0, 10, 15, 30, 60], including: minutes) { $0 == 0 ? "Off" : "\($0) min" },
                    selection: minutes
                ) { minutes in Task { await sync.perform(.switches(openAppAfterMinutes: minutes)) } }
            }
            .accessibilityIdentifier("settings.openAppAfter")
            NavigationLink {
                VocabularyView()
            } label: {
                let words = serverVocabulary(feed: sync.feed.vocabulary, pending: sync.pending)
                Row(
                    title: "Vocabulary", detail: words.shown.map { $0.count == 1 ? "1 word" : "\($0.count) words" },
                    state: words == .asking ? .asking : .known
                ) { RowValue() }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings.vocabulary")
            Row(title: "Low battery") {
                RowMenu(
                    title: "Low battery",
                    choices: choices([0, 10, 20, 30], including: lowBattery) { $0 == 0 ? "Off" : "Below \($0)%" },
                    selection: lowBattery
                ) { percent in
                    settings.alerts.lowBattery = percent > 0
                    if percent > 0 { settings.alerts.lowBatteryPercent = percent }
                }
            }
            .accessibilityIdentifier("pendant.settings.lowBattery")
            Row(title: "Low storage") {
                RowMenu(
                    title: "Low storage",
                    choices: choices([0, 70, 80, 90], including: lowStorage) { $0 == 0 ? "Off" : "Above \($0)% used" },
                    selection: lowStorage
                ) { used in
                    settings.alerts.lowPendantStorage = used > 0
                    if used > 0 { settings.alerts.lowPendantStoragePercent = 100 - used }
                }
            }
            .accessibilityIdentifier("pendant.settings.lowStorage")
            // The Limitless Pendant's light; an Omi has no command for it.
            if CaptureStore.pairedKind != .omi {
                NavigationLink {
                    LightGuideView(isConnected: isConnected, set: capture.setLightBrightness)
                } label: {
                    Row("Light guide") { RowValue() }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("pendant.settings.lightGuide")
            }
        }
    }

    /// The alert's value in the menu: off, or its threshold.
    private var lowBattery: Int { settings.alerts.lowBattery ? settings.alerts.lowBatteryPercent : 0 }
    private var lowStorage: Int {
        settings.alerts.lowPendantStorage ? 100 - settings.alerts.lowPendantStoragePercent : 0
    }

    /// The menu's choices, and the stored value too when it is none of them.
    private func choices(_ options: [Int], including stored: Int, name: (Int) -> String) -> [(choice: Int, name: String)] {
        (options.contains(stored) ? options : (options + [stored]).sorted()).map { ($0, name($0)) }
    }

    private var isConnected: Bool {
        if case .ready = capture.shown.connection { true } else { false }
    }

    // MARK: Your data, help

    private var yourData: some View {
        RowGroup(label: "Your data", surface: .sheet) {
            Row("Last backup", detail: lastBackup)
            NavigationLink {
                BackupView()
            } label: {
                Row("Backup & restore") { RowValue() }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("pendant.settings.backup")
        }
    }

    private var lastBackup: String? {
        guard let backup = sync.backup else { return nil }
        guard let at = backup.snapshot?.recordedAt else { return "None yet" }
        let time = at.formatted(date: .omitted, time: .shortened)
        if Calendar.current.isDateInToday(at) { return "Today, \(time)" }
        if Calendar.current.isDateInYesterday(at) { return "Yesterday, \(time)" }
        return at.formatted(date: .abbreviated, time: .shortened)
    }

    private var help: some View {
        RowGroup(label: "Help", surface: .sheet) {
            Row(title: "Version") {
                Text(Bundle.main.versionWords).font(.note).foregroundStyle(Palette.muted)
            }
            #if DEBUG
                NavigationLink {
                    DiagnosticsView()
                } label: {
                    Row("Diagnostics") { RowValue() }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("pendant.settings.diagnostics")
            #endif
        }
    }
}

extension Bundle {
    /// "1.0 (214)": the version and build in Info.plist.
    var versionWords: String {
        let info = infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))"
    }
}

/// A row for a value the server holds: asking, then the value; his change shows at once, then "Saved" for 2 s, or goes
/// back with the reason.
struct ServerRow<Value: Sendable & Equatable, Trailing: View>: View {
    let title: String
    var detail: String?
    let value: ServerValue<Value>
    @ViewBuilder let trailing: (Value) -> Trailing
    @State private var isSaved = false

    var body: some View {
        Row(title: title, detail: detail, state: state) {
            if let shown = value.shown { trailing(shown) }
        }
        .onChange(of: value) { old, new in
            if case .saving = old, case .known = new { isSaved = true } else { isSaved = false }
        }
        .task(id: isSaved) {
            guard isSaved else { return }
            try? await Task.sleep(for: .seconds(2))
            isSaved = false
        }
    }

    private var state: RowState {
        switch value {
        case .asking: .asking
        case .saving: .saving
        case .refused(_, let message, _): .refused(message)
        case .known: isSaved ? .saved : .known
        }
    }
}

/// The server this iPhone is paired with, and a pasted pairing link (confirmed on screen, never shown back).
/// Where this phone is paired, and the field to pair it again: for lifelog's server and for Life alike (`accepts` says
/// which links are its own). `note` is what a pairing in progress says, or why it failed.
struct PairingView: View {
    let title: String
    /// Who it is paired with, nil when not.
    let paired: String?
    let note: String?
    let accepts: (URL) -> Bool
    /// A pasted link is opened as the app's own link: the same path as the Camera's (`RootView`'s `onOpenURL`).
    @Environment(\.openURL) private var openURL

    @State private var draft = ""
    @State private var result: String?

    var body: some View {
        Form {
            Section {
                Label(
                    paired.map { "Paired with \($0)" } ?? "Not paired",
                    systemImage: paired == nil ? "link.badge.plus" : "link")
                if let note { Text(note).foregroundStyle(Palette.muted) }
                TextField("Pairing link", text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button(paired == nil ? "Pair" : "Pair again") {
                    let link = URL(string: draft.trimmingCharacters(in: .whitespacesAndNewlines))
                    if let link, accepts(link) {
                        openURL(link)
                        result = nil
                    } else {
                        result = "That isn't a pairing link."
                    }
                    draft = ""
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let result { Text(result).foregroundStyle(Palette.flag) }
            } footer: {
                Text(
                    "Scan the pairing code on your Mac with the Camera, or paste its link here. The token stays in this iPhone's Keychain and is never shown again."
                )
            }
        }
        .scrollContentBackground(.hidden)
        .background(Palette.bg)
        .navigationTitle(title)
    }
}

extension URL {
    /// A server as the owner reads it: its host.
    fileprivate var hostWords: String { host() ?? absoluteString }
}

#if DEBUG
    #Preview("Server") {
        NavigationStack {
            PairingView(title: "Server", paired: "mac.example.ts.net", note: nil, accepts: { _ in true })
        }
        .preferredColorScheme(.dark)
    }
#endif

extension SyncStore {
    /// The owner's switches as every screen shows them: the feed's, with a change waiting in the outbox applied. A
    /// change the server refused rolls back with it.
    var switches: ServerClient.Switches? { pending.switches(over: feed.switches) }
}

/// Settings as a sheet: its own stack, a close button, and the permissions it reads.
struct SettingsSheet: View {
    @Environment(CaptureStore.self) private var capture
    @Environment(\.dismiss) private var dismiss
    @State private var permissions = PermissionsStore()

    var body: some View {
        NavigationStack {
            SettingsView(
                permissions: permissions,
                allowNotifications: {
                    Task {
                        await capture.notifier.requestPermission()
                        await permissions.refresh()
                    }
                },
                close: { dismiss() })
        }
        .task { await permissions.refresh() }
    }
}
