import Incidents
import Library
import LifeConnector
import OwnerSettings
import PendantProtocol
import ServerAPI
import SwiftUI

/// Settings, the sheet over the app, in the order of what breaks the app: what needs him, the two connections, what this
/// phone allows, the Pendant, appearance, his data, help. It has pages of its own (Vocabulary, Light guide, Backup,
/// a page per connection), which push in the sheet's own stack. Drawn only with `Row` and `RowGroup`.
struct SettingsView: View {
    let permissions: PermissionsStore
    let close: () -> Void

    @Environment(SyncStore.self) private var sync
    @Environment(CaptureStore.self) private var capture
    @Environment(AppleHealthReader.self) private var appleHealth
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @Environment(\.openURL) private var openURL
    @AppStorage("appearance") private var appearance = Appearance.auto
    @AppStorage(AppGroup.Key.asksFaceIDToSend, store: AppGroup.defaults) private var asksFaceIDToSend = false
    @Bindable private var settings = Settings.shared
    @State private var page: Connection?
    @State private var isDiagnosticsOpen = false
    @State private var isLiveLogsOpen = false
    /// The problems (warn, error) Life logged in the last hour, as the Live logs row says them; nil until read.
    @State private var problems: String?
    @State private var isAppsOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            needsYou
            connections
            allows
            agents
            sending
            cards
            pendant
            dictation
            RowGroup(label: "Ask Life", surface: .sheet) {
                NavigationLink {
                    AskLifeSettingsPage()
                } label: {
                    Row(title: "Ask Life", icon: "waveform", detail: "Its look") {
                        RowValue()
                    }
                }
                .buttonStyle(.plain)
            }
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
            spending
            help
        }
        .motion(Motion.standard, value: needsYouRows)
        .readingWidth()
        .sheetScroll { SheetHeader(title: "Settings", font: .screenName, close: close) }
        .tint(Palette.fg)
        .background(Palette.sheet)
        .navigationDestination(item: $page) { ConnectionPage(connection: $0) }
        .navigationDestination(isPresented: $isDiagnosticsOpen) { DiagnosticsView() }
        .navigationDestination(isPresented: $isLiveLogsOpen) { LiveLogsPage { page = .life } }
        .task(id: life.parties.generation.current) { problems = await problemsLastHour() }
        .navigationDestination(isPresented: $isAppsOpen) { AppsPage() }
        #if DEBUG
            .task {
                switch LifeFixture.page {
                case "life": page = .life
                case "server": page = .server
                case "diagnostics": isDiagnosticsOpen = true
                case "logs": isLiveLogsOpen = true
                case "spending": router.show(.spending)
                case "apps": isAppsOpen = true
                default: break
                }
            }
        #endif
    }

    // MARK: Needs you

    /// What needs him, each with its one button; the group is absent when nothing does.
    private var needsYou: some View {
        RowGroup(label: "Needs you", labelColor: Palette.flag, surface: .sheet) {
            switch life.link {
            case .notPaired:
                Row(title: "Not paired", icon: "desktopcomputer", detail: "Inbox and Matters need Life on your Mac.") {
                    RowButton(title: "Pair with Life") { page = .life }
                }
            case .noAnswer:
                Row(title: "Life does not answer", icon: "desktopcomputer", detail: lifeSilence) {
                    RowButton(title: "Check") { page = .life }
                }
            case .works, .checking: EmptyView()
            }
            switch sync.link {
            case .notPaired:
                Row(title: "Server is not paired", icon: "cloud", detail: "Recording goes on; nothing is sent.") {
                    RowButton(title: "Pair") { page = .server }
                }
            case .noAnswer:
                Row(title: "Server does not answer", icon: "cloud", detail: "Audio waits on this phone.") {
                    RowButton(title: "Check") { page = .server }
                }
            case .works, .checking: EmptyView()
            }
            let transcription = TranscriptionFacts(sync)
            if let count = transcription.waiting[.creditsOut] {
                Row(
                    title: "ElevenLabs credits are out", icon: "creditcard",
                    detail: "\(conversationCount(count)) wait for words. Top up ElevenLabs and they go on their own.")
            }
            if let count = transcription.waiting[.macAway] {
                Row(
                    title: "\(conversationCount(count)) waiting for your Mac", icon: "desktopcomputer",
                    detail: transcription.macDetail)
            }
            if notificationsListed {
                let notAsked = permissions.notifications == .notAsked
                Row(
                    title: notAsked ? "Notifications not allowed yet" : "Notifications are off", icon: "bell",
                    detail: "Cards can't reach you.", state: permissions.asks[.notifications] ?? .known
                ) {
                    RowButton(
                        title: notAsked ? "Allow" : "Open", action: notAsked ? { ask(.notifications) } : openSettings)
                }
            }
        }
    }

    /// What decides the rows of "Needs you", so each one that comes or goes animates.
    private var needsYouRows: [String] {
        let waiting = TranscriptionFacts(sync).waiting
        return [
            "\(life.link)", "\(sync.link)", "\(waiting[.creditsOut] ?? 0)", "\(waiting[.macAway] ?? 0)",
            "\(notificationsListed)",
        ]
    }

    /// Notifications' problem is already in "Needs you": its row below keeps only the state.
    private var notificationsListed: Bool {
        switch permissions.notifications {
        case .notAsked, .denied, .restricted: true
        case .allowed, .asked, .limited: false
        }
    }

    private var lifeSilence: String {
        let since = life.inbox.loadedAt.map { "Last read \($0.formatted(date: .omitted, time: .shortened)). " } ?? ""
        return since + "The Mac may be asleep."
    }

    // MARK: Connections

    private var connections: some View {
        RowGroup(label: "Connections", surface: .sheet) {
            Button {
                page = .life
            } label: {
                Row(title: "Life", icon: "desktopcomputer", detail: life.pairedOrigin?.addressWords ?? "No Mac paired")
                {
                    HStack(spacing: 8) {
                        life.link.mark; RowValue()
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings.life")
            Button {
                page = .server
            } label: {
                Row(title: "Pendant server", icon: "cloud", detail: sync.server?.addressWords ?? "No server paired") {
                    HStack(spacing: 8) {
                        sync.link.mark; RowValue()
                    }
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
                "Notifications", icon: "bell", "Inbox cards reach you", permissions.notifications, kind: .notifications,
                ask: { ask(.notifications) },
                listed: notificationsListed)
            permission("Bluetooth", icon: "dot.radiowaves.left.and.right", "The pendant", bluetooth, ask: nil)
            permission(
                "Location", icon: "location", "Where things were said", permissions.location, kind: .location,
                ask: { ask(.location) })
            if AppleHealthReader.isAvailable {
                permission(
                    "Apple Health", icon: "heart", "Sleep and workouts", permissions.appleHealth, kind: .appleHealth
                ) {
                    Task {
                        await permissions.ask(.appleHealth)
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
        _ name: String, icon: String, _ why: String, _ access: PermissionsStore.Access,
        kind: PermissionsStore.Kind? = nil,
        ask: (() -> Void)?, listed: Bool = false
    ) -> some View {
        let id = "pendant.settings.\(name.lowercased())"
        let state = kind.flatMap { permissions.asks[$0] } ?? .known
        return Group {
            switch access {
            case .allowed:
                Row(title: name, icon: icon, detail: why, state: state) { StateMark(glyph: .ok, word: "On") }
            case .asked:
                // iOS never says whether reading was allowed.
                Row(title: name, icon: icon, detail: why, state: state) { StateMark(glyph: .off, word: "Asked") }
            case .notAsked:
                Row(title: name, icon: icon, detail: why, state: state) {
                    if let ask, !listed {
                        RowButton(title: "Allow", action: ask)
                    } else {
                        StateMark(glyph: .off, word: "Not asked")
                    }
                }
            case .limited(let what):
                Row(title: name, icon: icon, detail: what, state: state) {
                    RowButton(title: "Open", action: openSettings)
                }
            case .denied, .restricted:
                Row(title: name, icon: icon, detail: listed ? why : "Change it in iOS Settings", state: state) {
                    StateMark(glyph: .flag, word: "Off")
                    if !listed { RowButton(title: "Open", action: openSettings) }
                }
            }
        }
        .accessibilityIdentifier(id)
    }

    private func ask(_ kind: PermissionsStore.Kind) {
        Task { await permissions.ask(kind) }
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
    }

    // MARK: Agents

    /// His agents: the Agents page, in the Projects tab (the sheet closes).
    private var agents: some View {
        RowGroup(label: "Agents", surface: .sheet) {
            Button {
                router.show(.agents)
            } label: {
                let count = (life.agents.value?.agents ?? []).filter { !$0.isOver }.count
                Row(title: "Your agents", icon: "cpu", detail: count == 0 ? nil : "\(count) at work") { RowValue() }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings.agents")
        }
    }

    // MARK: Sending

    private var sending: some View {
        RowGroup(label: "Sending", surface: .sheet) {
            Row(
                title: "Face ID before Send", icon: "faceid",
                detail: asksFaceIDToSend
                    ? "Send from a notification waits for Face ID, on the phone only"
                    : "Send from a notification, on the phone or the Watch"
            ) {
                RowSwitch(title: "Face ID before Send", isOn: asksFaceIDToSend) { asksFaceIDToSend = $0 }
            }
            .accessibilityIdentifier("settings.switch.faceIDToSend")
        }
    }

    // MARK: Cards

    private var cards: some View {
        RowGroup(label: "Cards", surface: .sheet) {
            Button {
                isAppsOpen = true
            } label: {
                Row(title: "Apps", icon: "square.grid.2x2", detail: "The bank app a transfer opens") { RowValue() }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings.apps")
        }
    }

    // MARK: Dictation

    /// Where his words are heard when he talks into any field: one choice, each with what it means.
    private static let dictationChoices: [(heard: ServerClient.Switches.DictationHeard, title: String, line: String)] =
        [
            (.mac, "On your Mac", "Words appear when you pause, heard on your Mac."),
            (.instant, "Instant (ElevenLabs)", "Words appear as you speak. Your audio goes to ElevenLabs."),
        ]

    private var dictation: some View {
        let heard = serverValue(.dictationHeard, feed: sync.feed.switches, pending: sync.pending)
        return RowGroup(label: "Dictation", surface: .sheet) {
            ForEach(Self.dictationChoices, id: \.heard) { choice in
                let isChosen = heard.shown == choice.heard
                Button {
                    guard !isChosen else { return }
                    Task { await sync.perform(.switches(dictationHeard: choice.heard)) }
                } label: {
                    // The chosen row carries where the change stands; the other keeps its line.
                    ServerRow(
                        title: choice.title, detail: choice.line,
                        value: isChosen || heard.shown == nil ? heard : .known(choice.heard)
                    ) { shown in
                        if isChosen, shown == choice.heard {
                            Image(systemName: "checkmark").font(.smallStrong).foregroundStyle(Palette.fg)
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(heard.shown == nil)
                .accessibilityAddTraits(isChosen ? .isSelected : [])
                .accessibilityIdentifier("settings.dictation.\(choice.heard.rawValue)")
            }
        }
    }

    // MARK: Pendant

    private var pendant: some View {
        RowGroup(label: "Pendant", surface: .sheet) {
            ServerRow(
                title: "Transcribe what it hears", icon: "text.alignleft",
                value: serverValue(.transcription, feed: sync.feed.switches, pending: sync.pending)
            ) {
                RowSwitch(title: "Transcribe what it hears", isOn: $0) { on in
                    Task { await sync.perform(.switches(transcription: on)) }
                }
            }
            .accessibilityIdentifier("settings.switch.transcription")
            ServerRow(
                title: "Remind me to open the app", icon: "bell.badge",
                value: serverValue(.openAppAfterMinutes, feed: sync.feed.switches, pending: sync.pending)
            ) { minutes in
                RowMenu(
                    title: "Remind me to open the app",
                    choices: choices([0, 10, 15, 30, 60], including: minutes) { $0 == 0 ? "Off" : "After \($0) min" },
                    selection: minutes
                ) { minutes in Task { await sync.perform(.switches(openAppAfterMinutes: minutes)) } }
            }
            .accessibilityIdentifier("settings.openAppAfter")
            NavigationLink {
                VocabularyView()
            } label: {
                let words = serverVocabulary(feed: sync.feed.vocabulary, pending: sync.pending)
                Row(
                    title: "Vocabulary", icon: "textformat",
                    detail: words.shown.map { $0.count == 1 ? "1 word" : "\($0.count) words" },
                    state: words == .asking ? .asking : .known
                ) { RowValue() }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings.vocabulary")
            Row(title: "Warn me at low battery", icon: "bolt.batteryblock") {
                RowMenu(
                    title: "Warn me at low battery",
                    choices: choices([0, 10, 20, 30], including: lowBattery) { $0 == 0 ? "Off" : "Below \($0)%" },
                    selection: lowBattery
                ) { percent in
                    settings.alerts.lowBattery = percent > 0
                    if percent > 0 { settings.alerts.lowBatteryPercent = percent }
                }
            }
            .accessibilityIdentifier("pendant.settings.lowBattery")
            Row(title: "Warn me when storage fills", icon: "internaldrive") {
                RowMenu(
                    title: "Warn me when storage fills",
                    choices: choices([0, 70, 80, 90], including: lowStorage) { $0 == 0 ? "Off" : "Above \($0)%" },
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
                    Row(title: "Light guide", icon: "sun.max") { RowValue() }
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
    private func choices(_ options: [Int], including stored: Int, name: (Int) -> String) -> [(
        choice: Int, name: String
    )] {
        (options.contains(stored) ? options : (options + [stored]).sorted()).map { ($0, name($0)) }
    }

    private var isConnected: Bool {
        if case .ready = capture.shown.connection { true } else { false }
    }

    // MARK: Your data, help

    private var yourData: some View {
        RowGroup(label: "Your data", surface: .sheet) {
            NavigationLink {
                BackupView()
            } label: {
                Row(title: "Backup", icon: "square.and.arrow.up") {
                    HStack(spacing: 8) {
                        if backupValue == nil { StateGlyph.busy }
                        RowValue(text: backupValue)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("pendant.settings.backup")
        }
    }

    /// What Life costs: one plain row, no figure on it (a figure is never in front of him unless he opens it).
    private var spending: some View {
        RowGroup(surface: .sheet) {
            Button {
                router.show(.spending)
            } label: {
                Row(title: "Spending", icon: "chart.bar") { RowValue() }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings.spending")
        }
    }

    /// The backup row's value; nil until the status is read.
    private var backupValue: String? {
        guard sync.server != nil else { return "Not paired" }
        guard let backup = sync.backup else { return nil }
        guard let at = backup.snapshot?.recordedAt else { return "None yet" }
        let time = at.formatted(date: .omitted, time: .shortened)
        if Calendar.current.isDateInToday(at) { return "Today, \(time)" }
        if Calendar.current.isDateInYesterday(at) { return "Yesterday, \(time)" }
        return at.formatted(date: .abbreviated, time: .shortened)
    }

    /// "2 problems" from one page of the log's problems; "100+" when the page is full of the last hour's. Nil when there
    /// are none, or the read failed: the row never says none it does not know.
    private func problemsLastHour() async -> String? {
        let query = LogQuery(minLevel: .warn)
        let hourAgo = Date().addingTimeInterval(-3600)
        guard case .success(let page)? = await life.readLogLines(query) else { return nil }
        let count = page.lines.count { !($0.at < hourAgo) }
        if count == 0 { return nil }
        if count == 1 { return "1 problem" }
        return count == query.limit ? "\(count)+ problems" : "\(count) problems"
    }

    private var help: some View {
        RowGroup(label: "Help", surface: .sheet) {
            Row(title: "Build", icon: "info.circle") {
                Text(Bundle.main.buildWords).font(.note).foregroundStyle(Palette.muted)
            }
            Button {
                isDiagnosticsOpen = true
            } label: {
                Row(title: "Diagnostics", icon: "waveform.path.ecg") { RowValue() }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("pendant.settings.diagnostics")
            Button {
                isLiveLogsOpen = true
            } label: {
                // A problem in the last hour: a flag dot and how many.
                Row(title: "Live logs", icon: "waveform.path") {
                    if let problems {
                        StateDot(color: Palette.flag)
                        RowValue(text: problems)
                    } else {
                        RowValue()
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings.liveLogs")
        }
    }
}

extension Bundle {
    /// "1.0 (20261120.0412) · 0e1a221": the version, the build's date and its commit (`build-stamp.txt`, the build phase in `project.yml`).
    var buildWords: String {
        let commit = url(forResource: "build-stamp", withExtension: "txt").flatMap {
            try? String(contentsOf: $0, encoding: .utf8)
        }?.trimmingCharacters(in: .whitespacesAndNewlines)
        return [appVersion, commit].compactMap { $0 }.joined(separator: " · ")
    }
}

/// A row for a value the server holds: asking, then the value; his change shows at once, then "Saved" for 2 s, or goes
/// back with the reason.
struct ServerRow<Value: Sendable & Equatable, Trailing: View>: View {
    let title: String
    var icon: String?
    var detail: String?
    let value: ServerValue<Value>
    @ViewBuilder let trailing: (Value) -> Trailing
    @State private var isSaved = false

    var body: some View {
        Row(title: title, icon: icon, detail: detail, state: value.rowState(isSaved: isSaved)) {
            if let shown = value.shown { trailing(shown) }
        }
        .savedFlash(value, $isSaved)
    }
}

extension ServerValue {
    /// As a row shows it; `isSaved`: "Saved", for 2 s after the server took his change (`savedFlash`).
    func rowState(isSaved: Bool) -> RowState {
        switch self {
        case .asking: .asking
        case .saving: .saving
        case .refused(_, let message): .refused(message)
        case .known: isSaved ? .saved : .known
        }
    }
}

extension View {
    /// `isSaved` for 2 s once `value` goes from saving to known: the server took his change.
    func savedFlash<T>(_ value: ServerValue<T>, _ isSaved: Binding<Bool>) -> some View {
        onChange(of: value) { old, new in
            if case .saving = old, case .known = new {
                isSaved.wrappedValue = true
            } else {
                isSaved.wrappedValue = false
            }
        }
        .task(id: isSaved.wrappedValue) {
            guard isSaved.wrappedValue else { return }
            try? await Task.sleep(for: .seconds(2))
            isSaved.wrappedValue = false
        }
    }
}

extension SyncStore {
    /// The owner's switches as every screen shows them: the feed's, with a change waiting in the outbox applied. A
    /// change the server refused rolls back with it.
    var switches: ServerClient.Switches? { pending.switches(over: feed.switches) }
}

/// Settings as a sheet: its own stack, a close button, and the permissions it reads.
struct SettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var permissions = PermissionsStore()

    var body: some View {
        NavigationStack {
            SettingsView(
                permissions: permissions,
                close: { dismiss() })
        }
        .task { await permissions.refresh() }
    }
}
