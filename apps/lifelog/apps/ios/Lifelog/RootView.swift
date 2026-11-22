import Incidents
import LifeConnector
import SwiftUI
import UIKit

/// The shell (`NavShell`: the page, the list and the bottom bar), with the Pendant sheet over it, and Ask Life's round
/// button over all. Every sheet is centred and closes from inside itself.
struct RootView: View {
    @Environment(CaptureStore.self) private var capture
    @Environment(SyncStore.self) private var sync
    @Environment(LifeStore.self) private var life
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var router = AppRouter()
    @Namespace private var topBarZoom
    @AppStorage("appearance") private var appearance = Appearance.auto
    /// A pairing link the owner is asked to confirm, once any sheet is out of the way: the lifelog server, Life, or both.
    @State private var confirming: PairOffer?

    var body: some View {
        NavShell()
            .sheet(item: $router.sheet) { sheet in
                switch sheet {
                case .pendant: PendantView().sheetStack().zooms(from: sheet, in: topBarZoom)
                }
            }
            // Ask Life: one round glass button in the bottom-right corner of the root, whatever the pose, so a fold or a
            // rotation never moves it off the corner (52 on the phone; in the Duo's column 48, centred over the system tab pill, which the system keeps at the foot).
            .overlay(alignment: .bottomTrailing) {
                if life.isPaired {
                    AskLifeControl(
                        running: life.askLife.strands.filter { !$0.isDone }.count,
                        place: router.isBarsInColumn ? .column : .phone, isRegular: sizeClass == .regular
                    )
                    // Past the system's safe areas (the column's, the bar's): the screen's own corner.
                    .ignoresSafeArea()
                }
            }
            .sheet(item: $confirming) { PairSheet(offer: $0).sheetStack() }
            .overlay(alignment: .bottom) {
                if life.isPaired, router.isAskLifeSmall, !router.isAskLifeOpen {
                    AskLifeStrip(
                        line: life.askLife.answer?.line ?? "Working on it…", open: { router.isAskLifeOpen = true },
                        close: {
                            router.isAskLifeSmall = false
                            router.askLifeContext = nil
                        }
                    )
                    .appears(Motion.fade)
                }
            }
            .fullScreenCover(isPresented: $router.isAskLifeOpen) { AskLifeScreen() }
            // What an answer shows: its tab's list cut, or a page, under Ask Life's strip.
            .onChange(of: life.askLife.shown) { _, shown in if let shown { router.open(shown: shown.show) } }
            // The one shell (decision 96): every screen's scroll runs edge to edge, top of the device to its foot, under the
            // floating title, controls, answers and tabs, softened at both edges by iOS's soft scroll edge alone.
            .scrollEdgeEffectStyle(.soft, for: .all)
            .sheet(item: $router.appointment) { AppointmentSheet(key: $0) }
            // Below the sheets, so their pages read them too: Settings' Live logs page (its `ReadScreen`) reads the router.
            .environment(router)
            .environment(\.topBarZoom, topBarZoom)
            .environment(\.windowSizeClass, sizeClass)
            .preferredColorScheme(appearance.scheme)
            // A tapped notification, from a cold launch, the background or the foreground.
            #if DEBUG
                .task { await showFixtureScreen() }
            #endif
            .onChange(of: capture.routeToOpen, initial: true) { _, route in
                guard let route else { return }
                capture.routeToOpen = nil
                open(route)
            }
            // A card's push while the app is in front: the inbox alone is read again.
            .task(id: capture.cardPushes) {
                if capture.cardPushes > 0 { await life.refreshInbox() }
            }
            .task(id: scenePhase == .active) {
                guard scenePhase == .active else { return }
                // Here rather than on the scene's phase change, which a cold launch in the foreground never sends.
                sync.becameActive()
                #if DEBUG
                    await life.importFromEnvironment()
                #endif
                await life.refreshOnForeground()
                // A first read that did not land tries again while the scene is active; leaving cancels the sleep.
                var attempt = 0
                while life.needsRetry {
                    guard (try? await Task.sleep(for: firstReadRetryDelay(attempt: attempt))) != nil else { return }
                    attempt += 1
                    await life.retryFirstReads()
                }
                // In front, the main reads are read again every minute: what changed on the Mac (an agent freed, a turn
                // resumed) shows with no push. The versioned ones cost one small answer when nothing changed.
                while (try? await Task.sleep(for: SyncMark.readEvery)) != nil { await life.refresh() }
            }
            // A pairing link (`lifelog://pair?…`), from the Camera or pasted in Settings: a link could come from anywhere, so
            // it is asked here, over whatever was showing, and never repoints the app on its own.
            .onOpenURL { url in
                if let offer = PairOffer(link: url) { dismissSheet { confirming = offer } }
            }
            .font(.body15)
            .tint(Palette.fg)
    }

    /// Runs `then` once no sheet is up, dismissing the one that is.
    private func dismissSheet(then: @escaping () -> Void) {
        let presented = UIApplication.shared.connectedScenes.lazy
            .compactMap { ($0 as? UIWindowScene)?.keyWindow?.rootViewController?.presentedViewController }.first
        guard let presented else { return then() }
        presented.dismiss(animated: true, completion: then)
    }

    /// The Inbox, at the push's card, set at once; any sheet over it closes meanwhile, as Mail and Messages do, so what
    /// opens is in view without waiting for the sheet to go.
    private func open(_ route: NotificationRoute) {
        switch route {
        case .card(let pushId, let card, let kept): Task { await life.open(pushId: pushId, card: card, life: kept) }
        case .inbox: Task { await life.refreshInbox() }
        case .removed: return  // A background push: never shown, never tapped.
        // Its event sheet over the tab he was on, once any other sheet is out of the way.
        case .appointment(let pushId): return dismissSheet { router.appointment = .pushId(pushId) }
        }
        (router.tab, router.isDrawerOpen) = (.inbox, false)
        dismissSheet {}
    }
}

#if DEBUG
    extension RootView {
        /// `-fixtureTab projects|people`, `-fixtureCard`, `-fixtureMatter`, `-fixturePerson`, `-fixtureSheet`: open the screen a launch
        /// asked to see.
        fileprivate func showFixtureScreen() async {
            try? await Task.sleep(for: .milliseconds(1_200))
            switch LifeFixture.tab {
            case "projects": router.tab = .projects
            case "people": router.tab = .people
            default: break
            }
            if LifeFixture.drawer == "open" { router.isDrawerOpen = true }
            if let id = LifeFixture.matter { router.open(matter: id) }
            if let ref = LifeFixture.person { router.open(party: ref) }
            // On a matter, the card is the ask pushed on it; alone, the Inbox opens at it, as a push does.
            if let ref = LifeFixture.card {
                if LifeFixture.matter == nil {
                    await life.open(ref: ref)
                } else {
                    router.matterPath = [.card(ref, matter: LifeFixture.matter ?? "")]
                }
            }
            if let sheet = LifeFixture.sheet.flatMap(AppRouter.Sheet.init(rawValue:)) { router.sheet = sheet }
            // Settings is the Profile page's, pushed on it.
            if LifeFixture.sheet == "settings" { router.openSettings() }
            // The pendant sheet's own sheets open from inside it (`PendantScreen`).
            if ["replacePendant", "pairPendant"].contains(LifeFixture.sheet) { router.sheet = .pendant }
            if LifeFixture.sheet == "agent" { router.matterSheet = LifeFixture.matter.map { .agent($0) } }
            if LifeFixture.sheet == "agents" { router.show(.agents) }
            if LifeFixture.show == "matters" {
                await life.refreshMatters()
                let refs = (life.matters.value?.matters ?? []).prefix(3).map(\.id)
                router.open(
                    shown: .list(ShownList(kind: .matters, refs: Array(refs), label: "Your 3 most important today")))
            }
            // The page of the matter's agent, pushed on the matter.
            if LifeFixture.sheet == "agentPage", let id = LifeFixture.matter {
                await life.refreshAgents()
                let agents = life.agents.value?.agents ?? []
                if let agent = (agents.first { $0.matter?.id == id } ?? agents.first)?.id { router.open(agent: agent) }
            }
            // `-fixtureSheet session -fixtureAgent pi`: the lease's agent's session, pushed on its page.
            if LifeFixture.sheet == "session" {
                router.open(agent: "agt_lease")
                router.matterPath.append(.session("agt_lease"))
            }
            if LifeFixture.ask == "open" { router.isAskOpen = true }
            if LifeFixture.sheet == "icon" { router.matterSheet = LifeFixture.matter.map { .icon($0) } }
            if ["pair", "pairing"].contains(LifeFixture.sheet) {
                confirming = URL(string: "lifelog://pair?life=https%3A%2F%2Flife.example.test&code=ABC234").flatMap(
                    PairOffer.init)
            }
        }
    }
#endif

/// Dark, light, or whatever the phone says.
enum Appearance: String {
    case auto, light, dark

    var scheme: ColorScheme? {
        switch self {
        case .auto: nil
        case .light: .light
        case .dark: .dark
        }
    }
}
