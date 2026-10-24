import Incidents
import Library
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
    @Environment(ButtonActions.self) private var buttons
    @Environment(\.library) private var library
    @Environment(\.scenePhase) private var scenePhase
    @State private var screen = Screen.pendant
    /// The Library tab's list.
    @State private var list: LibraryListStore?
    /// The Library tab's stack, here so a notification can open People on it.
    @State private var libraryPath: [LibraryRoute] = []
    /// A pairing link the owner is asked to confirm, once any sheet is out of the way.
    @State private var confirming: Pairing?

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
        }
        // A pairing link, from the Camera or pasted in Settings: asked here, over whatever was showing.
        .onChange(of: sync.offeredPairing) { _, pairing in
            guard let pairing else { return }
            sync.offeredPairing = nil
            dismissSheet { confirming = pairing }
        }
        .alert(
            "Pair with \(confirming.map(Self.address) ?? "this server")?",
            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            presenting: confirming
        ) { pairing in
            Button("Pair") { _ = sync.pair(pairing) }
            Button("Cancel", role: .cancel) {}
        } message: { pairing in
            Text(pairingMessage(pairing))
        }
        .playbackHost()
        .tint(Palette.redText)
        .preferredColorScheme(.dark)
    }

    /// A server as the owner reads it: its host, and its port when it isn't the usual one.
    private static func address(_ pairing: Pairing) -> String { address(pairing.server) }
    private static func address(_ server: URL) -> String {
        [server.host(), server.port.map(String.init)].compactMap(\.self).joined(separator: ":")
    }

    /// What pairing with a new server changes: everything from now on goes there.
    private func pairingMessage(_ pairing: Pairing) -> String {
        guard let current = sync.server, current != pairing.server else {
            return "Your recordings, edits and backups will go to this server."
        }
        return "This iPhone sends to \(Self.address(current)) now. Pair only if your archive moved to this address."
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
