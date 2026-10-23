import Capture
import Incidents
import Library
import OwnerSettings
import PendantProtocol
import ServerAPI
import SourceStore
import SwiftUI
import Timeline

/// The Pendant tab: am I recording, everything useful at a glance, what needs me, and the way into Settings. Reads
/// the stores; `PendantScreen` draws plain values so previews can show every state.
struct PendantView: View {
    @Environment(CaptureStore.self) private var capture
    @Environment(SyncStore.self) private var sync
    @Environment(\.scenePhase) private var scenePhase
    @State private var permissions = PermissionsStore()
    @State private var today: SavedToday?

    var body: some View {
        NavigationStack {
            PendantScreen(
                capture: CaptureFacts(capture, macDictatingSince: sync.macDictatingSince),
                transcription: TranscriptionFacts(sync),
                today: today,
                permissions: permissions,
                showsNotificationsInvite: permissions.notifications == .notAsked && capture.hasKnownPendant
                    && !Settings.shared.notificationsInviteDismissed,
                actions: PendantActions(capture: capture, sync: sync, permissions: permissions))
        }
        .task(id: scenePhase) { await permissions.refresh() }
        // On screen in the foreground: keep "Recording." and the sound line backed by current evidence. A status every
        // few seconds, never a control write; stops when the screen or the app goes away.
        .task(id: scenePhase == .active && capture.availability == .running) {
            guard scenePhase == .active else { return }
            await capture.watchLive()
        }
        .modifier(TodayReload(today: $today))
    }
}

/// What was recorded today changes as the server groups new audio: read again whenever the driver changed the
/// cache. A view of its own, so a change wakes only this, not the
/// Pendant screen.
private struct TodayReload: ViewModifier {
    @Binding var today: SavedToday?
    @Environment(SyncStore.self) private var sync
    @Environment(\.library) private var library

    func body(content: Content) -> some View {
        content.task(id: sync.generation) {
            guard let library else { return }
            today = await SavedToday.load(from: library)
        }
    }
}

/// The frame around the Lens layout: toolbar, toast, haptics, pull to refresh, the attention cards and the moments the
/// screen re-reads.
struct PendantScreen: View {
    let capture: CaptureFacts
    let transcription: TranscriptionFacts
    let today: SavedToday?
    let permissions: PermissionsStore
    let showsNotificationsInvite: Bool
    let actions: PendantActions

    @State private var mark: MarkResult?

    var body: some View {
        TimelineView(.explicit(capture.boundaries(after: .now))) { timeline in
            let now = timeline.date
            let conditions = CaptureCondition.evaluate(capture.status, context: capture.context, now: now)
            let cards = conditions.filter(\.isCard)
            let input = PendantLayoutInput(
                capture: capture, transcription: transcription,
                hero: hero(conditions: conditions, now: now),
                glance: glance(now: now), actions: actions, split: split, now: now)
            let status = capture.status
            let omi = capture.pairedKind == .omi && OmiFirmware.freesOnDelivery(status.firmwareRevision)
            let attention = AttentionList(
                conditions: cards, incidents: capture.incidents, transcription: transcription,
                showsNotificationsInvite: showsNotificationsInvite,
                omiCustody: omi ? OmiCustodyCard(revision: status.firmwareRevision) : nil,
                actions: actions)
            ScrollView {
                LensLayout(input: input) { attention }
                    // A card arriving or leaving eases what is below out of its way instead of jumping it.
                    .motion(
                        Motion.rise,
                        value: AttentionKey(
                            conditions: cards.map(\.title), incidents: capture.incidents.map(\.id),
                            transcription: transcription, invite: showsNotificationsInvite, omi: omi))
            }
            // No title over the home screen: the bar stays for its buttons, and content softens under it.
            .scrollEdgeEffectStyle(.soft, for: .top)
            .stillWhileScrolling()
        }
        .background(Palette.ground)
        // Named for the back button on pages pushed from here, never shown on this one.
        .navigationTitle("Pendant")
        .toolbar(removing: .title)
        .toolbarTitleDisplayMode(.inline)
        .refreshable { await actions.refresh() }
        .connectionStatus()
        .toolbar {
            if capture.macDictatingSince != nil {
                ToolbarItem(placement: .topBarLeading) {
                    // Text, not a Label: the bar would draw a Label as its icon alone.
                    Text("\(Image(systemName: "laptopcomputer")) Mac dictating")
                        .font(.subheadline)
                        .fixedSize()
                        // The words alone: VoiceOver would read the symbol's name first.
                        .accessibilityLabel("Mac dictating")
                        .accessibilityIdentifier("pendant.macDictating")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    SettingsView(permissions: permissions, allowNotifications: actions.allowNotifications)
                } label: {
                    Label("Settings", systemImage: "gearshape")
                }
                .accessibilityIdentifier("pendant.settings")
            }
        }
        // An inset, not an overlay: the rows can scroll clear of it, and it never takes their taps.
        .safeAreaInset(edge: .bottom) {
            if let mark {
                MarkToast(result: mark)
                    .accessibilityIdentifier("pendant.markToast")
                    .padding(.bottom, 12)
                    .allowsHitTesting(false)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .motion(Motion.rise, value: mark)
        .sensoryFeedback(trigger: mark) { _, mark in
            switch mark {
            case .splitFailed?: .error
            // The scissors gave their own light tap already.
            case .split?, nil: nil
            }
        }
        .task(id: mark) {
            // A newer mark cancels this wait and keeps its own toast.
            guard mark != nil, (try? await Task.sleep(for: .seconds(2.6))) != nil else { return }
            mark = nil
        }
    }

    private func split() {
        let at = Date.now
        Task {
            let error = await actions.split(at: at)
            mark = error.map(MarkResult.splitFailed) ?? .split(at: at)
            if let mark { AccessibilityNotification.Announcement(mark.sentence).post() }
        }
    }

    /// An Omi has no pause or resume command: its hero offers neither.
    private func hero(conditions: [CaptureCondition], now: Date) -> HeroReading {
        var hero = HeroReading(status: capture.status, conditions: conditions, now: now)
        if capture.pairedKind == .omi, [.pause, .resume].contains(hero.control) { hero.control = .none }
        return hero
    }

    private func glance(now: Date) -> GlanceFacts {
        let status = capture.status
        let connected = if case .ready = status.connection { true } else { false }
        return GlanceFacts(
            connection: status.connection, battery: Fact(status.batteryPercent, connected: connected, now: now),
            charging: status.charging, storage: Fact(status.storage, connected: connected, now: now),
            sync: SyncSummary(status.sync, lastCaughtUp: capture.lastCaughtUp),
            backlog: Fact(status.backlog, connected: connected, now: now), lastCaughtUp: capture.lastCaughtUp,
            lastSaved: capture.lastSaved, phoneFreeBytes: capture.phoneFreeBytes, archiveBytes: capture.archiveBytes,
            today: today, spending: transcription.spending,
            isPaired: transcription.isPaired, batteryLife: capture.batteryLife)
    }
}

/// Which attention cards show: a change animates them in or out.
private struct AttentionKey: Equatable {
    var conditions: [String]
    var incidents: [IncidentItem.ID]
    var transcription: TranscriptionFacts
    var invite: Bool
    var omi: Bool
}

/// Everything waiting on the owner, as calm cards. Nothing at all when nothing is.
private struct AttentionList: View {
    let conditions: [CaptureCondition]
    let incidents: [IncidentItem]
    let transcription: TranscriptionFacts
    let showsNotificationsInvite: Bool
    /// Shown while the Omi's firmware frees audio on delivery.
    let omiCustody: OmiCustodyCard?
    let actions: PendantActions

    var body: some View {
        if !conditions.isEmpty || !incidents.isEmpty || transcription.needsOwner || showsNotificationsInvite
            || omiCustody != nil
        {
            VStack(spacing: 12) {
                if let omiCustody { omiCustody }
                ConditionCards(conditions: conditions, perform: actions.recover)
                IncidentCards(incidents: incidents, resolve: actions.resolve)
                TranscriptionCards(facts: transcription)
                if showsNotificationsInvite {
                    NotificationsInvite(
                        allow: actions.allowNotifications, dismiss: actions.dismissNotificationsInvite)
                }
            }
        }
    }
}
