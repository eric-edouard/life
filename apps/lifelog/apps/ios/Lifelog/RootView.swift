import Incidents
import LifeConnector
import SwiftUI
import UIKit

/// Two tabs, Inbox (home) and Matters, with the Settings and Pendant sheets over them.
struct RootView: View {
    @Environment(CaptureStore.self) private var capture
    @Environment(SyncStore.self) private var sync
    @Environment(LifeStore.self) private var life
    @Environment(\.scenePhase) private var scenePhase
    @State private var router = AppRouter()
    @AppStorage("appearance") private var appearance = Appearance.auto
    /// A pairing link the owner is asked to confirm, once any sheet is out of the way: the lifelog server, Life, or both.
    @State private var confirming: PairOffer?

    var body: some View {
        TabView(selection: $router.tab) {
            Tab("Inbox", systemImage: "tray", value: AppRouter.Tab.inbox) {
                NavigationStack { InboxScreen().shellBar("Inbox") }
            }
            .badge(life.inbox.value?.badge ?? 0)
            Tab("Matters", systemImage: "list.bullet.indent", value: AppRouter.Tab.matters) { MattersScreen() }
        }
        .environment(router)
        .sheet(item: $router.sheet) { sheet in
            switch sheet {
            case .pendant: PendantView().presentationPlacement(.trailing)
            case .settings: SettingsSheet().presentationPlacement(.trailing)
            }
        }
        .sheet(item: $confirming) { PairSheet(offer: $0).presentationPlacement(.trailing) }
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
        // A card's push while the app is in front: the inbox is read again, as on coming back to it.
        .task(id: capture.cardPushes) {
            if capture.cardPushes > 0 { await life.refresh() }
        }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            // Here rather than on the scene's phase change, which a cold launch in the foreground never sends.
            sync.becameActive()
            #if DEBUG
                await life.importFromEnvironment()
            #endif
            await life.refresh()
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

    /// Closes any sheet first, as Mail and Messages do, so what opens is in view whatever sheet was showing: the Inbox,
    /// at the push's card.
    private func open(_ route: NotificationRoute) {
        dismissSheet {
            router.tab = .inbox
            switch route {
            case .card(let pushId): Task { await life.open(pushId: pushId) }
            case .inbox: Task { await life.refreshInbox() }
            }
        }
    }
}

#if DEBUG
    extension RootView {
        /// `-fixtureTab`, `-fixtureCard`, `-fixtureMatter`, `-fixtureSheet`: open the screen a launch asked to see.
        fileprivate func showFixtureScreen() async {
            try? await Task.sleep(for: .milliseconds(1_200))
            if LifeFixture.tab == "matters" { router.tab = .matters }
            if let id = LifeFixture.matter { router.open(matter: id) }
            if let ref = LifeFixture.card { router.answer(card: ref) }
            if let sheet = LifeFixture.sheet.flatMap(AppRouter.Sheet.init(rawValue:)) { router.sheet = sheet }
            // The pendant sheet's own sheets open from inside it (`PendantScreen`).
            if ["replacePendant", "pairPendant"].contains(LifeFixture.sheet) { router.sheet = .pendant }
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
