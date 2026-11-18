import Incidents
import Library
import LifeConnector
import ServerAPI
import SwiftUI
import UIKit

/// Pendant, Library and the Pendant's presses. Each tab's view is owned by one feature folder and reads the feature
/// stores.
struct RootView: View {
    private enum Screen: Hashable {
        case pendant, library, presses
    }

    @Environment(CaptureStore.self) private var capture
    @Environment(SyncStore.self) private var sync
    @Environment(NamingQueue.self) private var naming
    @Environment(LifeStore.self) private var life
    @Environment(ButtonActions.self) private var buttons
    @Environment(\.library) private var library
    @Environment(\.scenePhase) private var scenePhase
    @State private var screen = Screen.pendant
    /// The Library tab's list.
    @State private var list: LibraryListStore?
    /// The Library tab's stack, here so a notification can open People on it.
    @State private var libraryPath: [LibraryRoute] = []
    /// A pairing link the owner is asked to confirm, once any sheet is out of the way: the lifelog server, Life, or both.
    @State private var confirming = Offer()

    private struct Offer {
        var server: Pairing?
        var life: LifePairing?
        var isEmpty: Bool { server == nil && life == nil }
    }

    var body: some View {
        TabView(selection: $screen) {
            Tab("Pendant", systemImage: "record.circle", value: .pendant) { PendantView() }
            Tab("Library", systemImage: "books.vertical", value: .library) {
                LibraryView(store: list, path: $libraryPath)
            }
            Tab("Presses", systemImage: "hand.tap", value: .presses) { PressesView() }
        }
        .onAppear {
            if list == nil, let library { list = LibraryListStore(library: library, sync: sync) }
            PressOverlay.install(buttons)
        }
        // The driver applied the feed, or the owner edited: the loaded rows are read again.
        .onChange(of: sync.generation) { Task { await list?.reload() } }
        // A tapped notification, from a cold launch, the background or the foreground.
        .onChange(of: capture.routeToOpen, initial: true) { _, route in
            guard let route else { return }
            capture.routeToOpen = nil
            open(route)
        }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            // Here rather than on the scene's phase change, which a cold launch in the foreground never sends.
            sync.becameActive()
            await naming.refresh()
            #if DEBUG
                await life.importFromEnvironment()
            #endif
            if life.isPaired { await life.refresh() }
        }
        // A pairing link, from the Camera or pasted in Settings: asked here, over whatever was showing.
        .onChange(of: sync.offeredPairing) { _, pairing in
            guard let pairing else { return }
            sync.offeredPairing = nil
            dismissSheet { confirming.server = pairing }
        }
        .onChange(of: life.offered) { _, pairing in
            guard let pairing else { return }
            life.offered = nil
            dismissSheet { confirming.life = pairing }
        }
        .alert(
            "Pair with \(Self.names(confirming))?",
            isPresented: Binding(get: { !confirming.isEmpty }, set: { if !$0 { confirming = Offer() } }),
            presenting: confirming
        ) { offer in
            Button("Pair") {
                if let server = offer.server { _ = sync.pair(server) }
                if let link = offer.life { Task { await life.pair(link) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: { offer in
            Text(pairingMessage(offer))
        }
        .playbackHost()
        .tint(Palette.redText)
        .preferredColorScheme(.dark)
    }

    /// A server as the owner reads it: its host, and its port when it isn't the usual one.
    private static func address(_ server: URL) -> String {
        [server.host(), server.port.map(String.init)].compactMap(\.self).joined(separator: ":")
    }

    /// Both servers by name when the link carries both.
    private static func names(_ offer: Offer) -> String {
        [offer.server.map { address($0.server) }, offer.life.map { "Life at \(address($0.origin))" }]
            .compactMap(\.self).joined(separator: " and ")
    }

    /// What pairing changes: with a new lifelog server, everything from now on goes there; with Life, this app reads
    /// what waits on you and acts on your word.
    private func pairingMessage(_ offer: Offer) -> String {
        let lifelog: String? = offer.server.map { pairing in
            guard let current = sync.server, current != pairing.server else {
                return "Your recordings, edits and backups will go to this server."
            }
            return "This iPhone sends to \(Self.address(current)) now. Pair only if your archive moved to this address."
        }
        let toLife = offer.life.map { _ in "Life will show what waits on you here." }
        return [lifelog, toLife].compactMap(\.self).joined(separator: " ")
    }

    /// Closes any sheet first, as Mail and Messages do, so what opens is in view whatever tab or sheet was showing. The
    /// route waits for the sheet to go: a push made during its dismissal lands as an empty page.
    private func open(_ route: NotificationRoute) {
        dismissSheet { show(route) }
    }

    /// Runs `then` once no sheet is up, dismissing the one that is.
    private func dismissSheet(then: @escaping () -> Void) {
        let presented = UIApplication.shared.connectedScenes.lazy
            .compactMap { ($0 as? UIWindowScene)?.keyWindow?.rootViewController?.presentedViewController }.first
        guard let presented else { return then() }
        presented.dismiss(animated: true, completion: then)
    }

    private func show(_ route: NotificationRoute) {
        switch route {
        case .peopleDigest:
            screen = .library
            libraryPath = [.naming]
        case .quickQuestion(let words): buttons.showQuestion(words)
        }
    }
}
