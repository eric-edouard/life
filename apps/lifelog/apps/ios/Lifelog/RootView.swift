import Incidents
import LifeConnector
import SwiftUI
import UIKit

/// The bottom group, all system pieces: the Inbox (home), Projects and People tabs and the system's search tab, with the
/// Settings and Pendant sheets over them. Every sheet is centred, the system's default, and closes from inside itself.
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
    @State private var query = ""
    @State private var scope = SearchScope.all

    init() {
        // The Inbox's count is `flag` (it needs him), not the system's red; SwiftUI's `badge` takes no colour.
        let bar = UITabBarAppearance()
        for item in [bar.stackedLayoutAppearance, bar.inlineLayoutAppearance, bar.compactInlineLayoutAppearance] {
            item.normal.badgeBackgroundColor = UIColor(Palette.flag)
            item.normal.badgeTextAttributes = [.foregroundColor: UIColor(Palette.on)]
        }
        UITabBar.appearance().standardAppearance = bar
        UITabBar.appearance().scrollEdgeAppearance = bar
    }

    var body: some View {
        TabView(selection: tabs) {
            Tab("Inbox", systemImage: "tray", value: AppRouter.Tab.inbox) {
                InboxScreen()
            }
            .badge(life.badge)
            Tab("Projects", systemImage: "list.bullet.indent", value: AppRouter.Tab.projects) { ProjectsScreen() }
            Tab("People", systemImage: "person.2", value: AppRouter.Tab.people) { PeopleScreen() }
            // Its title and symbol are the system's; it sits apart, at the trailing end of the tabs.
            Tab(value: AppRouter.Tab.search, role: .search) {
                // The field belongs to this tab alone: on the tabs it would show on Inbox and Projects too.
                NavigationStack {
                    SearchScreen(query: query, scope: scope).shellBar("", hasSettings: false)
                        .searchable(text: $query, prompt: "Search")
                        .searchScopes($scope, activation: .onSearchPresentation) {
                            ForEach(SearchScope.allCases, id: \.self) { Text($0.word).tag($0) }
                        }
                }
            }
        }
        .sheet(item: $router.sheet) { sheet in
            switch sheet {
            case .pendant: PendantView().sheetStack().zooms(from: sheet, in: topBarZoom)
            case .settings: SettingsSheet().zooms(from: sheet, in: topBarZoom)
            }
        }
        .sheet(item: $confirming) { PairSheet(offer: $0).sheetStack() }
        // Tell Life: always within reach, in the rail's free middle, on every screen: on the Pendant's vertical line, so it
        // stands in the closed Duo's side column with the other controls (decision 89), at the bar's end elsewhere.
        .overlay {
            if life.isPaired {
                GeometryReader { window in
                    let x = router.trailingControlsX.map { $0 - window.frame(in: .global).minX }
                    TellLifeButton()
                        .position(x: x ?? window.size.width - Metrics.Spacing.m - 28, y: window.size.height / 2)
                }
                .ignoresSafeArea()
            }
        }
        .fullScreenCover(isPresented: $router.isTellLifeOpen) { TellLifeScreen() }
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
            // An answer held for Undo goes now: nothing waits in the background.
            guard scenePhase == .active else { return await sendHeldInBackground() }
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
        }
        // A pairing link (`lifelog://pair?…`), from the Camera or pasted in Settings: a link could come from anywhere, so
        // it is asked here, over whatever was showing, and never repoints the app on its own.
        .onOpenURL { url in
            if let offer = PairOffer(link: url) { dismissSheet { confirming = offer } }
        }
        .font(.body15)
        .tint(Palette.fg)
    }

    /// The tabs, where tapping Projects again goes back to All.
    private var tabs: Binding<AppRouter.Tab> {
        Binding(
            get: { router.tab },
            set: { tab in
                if tab == .projects, router.tab == .projects { router.chip = nil }
                router.tab = tab
            })
    }

    /// Held answers go now, and the app is kept awake until they and those already going are answered: a suspended app would lose them.
    private func sendHeldInBackground() async {
        guard life.hasAnswersUnderWay else { return }
        let app = UIApplication.shared
        let awake = Awake()
        awake.id = app.beginBackgroundTask(withName: "held answers") { awake.end() }
        await life.sendHeld()
        awake.end()
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
        router.tab = .inbox
        dismissSheet {}
    }
}

#if DEBUG
    extension RootView {
        /// `-fixtureTab projects|people|search`, `-fixtureCard`, `-fixtureMatter`, `-fixturePerson`, `-fixtureSheet`: open the screen a launch
        /// asked to see.
        fileprivate func showFixtureScreen() async {
            try? await Task.sleep(for: .milliseconds(1_200))
            switch LifeFixture.tab {
            case "projects": router.tab = .projects
            case "people": router.tab = .people
            case "search": router.tab = .search
            default: break
            }
            if let id = LifeFixture.matter { router.open(matter: id) }
            if let ref = LifeFixture.person { router.open(party: ref) }
            // On a matter, the card is the ask pushed on it; alone, the Inbox opens at it, as a push does.
            if let ref = LifeFixture.card {
                if LifeFixture.matter == nil { await life.open(ref: ref) } else { router.matterPath = [.card(ref)] }
            }
            if let sheet = LifeFixture.sheet.flatMap(AppRouter.Sheet.init(rawValue:)) { router.sheet = sheet }
            // The pendant sheet's own sheets open from inside it (`PendantScreen`).
            if ["replacePendant", "pairPendant"].contains(LifeFixture.sheet) { router.sheet = .pendant }
            if LifeFixture.sheet == "agent" { router.matterSheet = LifeFixture.matter.map { .agent($0) } }
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
