import LifeConnector
import ServerAPI
import SwiftUI
import UIKit

/// The Pendant tab alone: the minimal shell until the new screens replace it.
struct RootView: View {
    @Environment(SyncStore.self) private var sync
    @Environment(LifeStore.self) private var life
    @Environment(\.scenePhase) private var scenePhase
    /// A pairing link the owner is asked to confirm, once any sheet is out of the way: the lifelog server, Life, or both.
    @State private var confirming = Offer()

    private struct Offer {
        var server: Pairing?
        var life: LifePairing?
        var isEmpty: Bool { server == nil && life == nil }
    }

    var body: some View {
        TabView {
            Tab("Pendant", systemImage: "record.circle") { PendantView() }
        }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            // Here rather than on the scene's phase change, which a cold launch in the foreground never sends.
            sync.becameActive()
            #if DEBUG
                await life.importFromEnvironment()
            #endif
            if life.isPaired { await life.refresh() }
        }
        // A pairing link (`lifelog://pair?…`), from the Camera or pasted in Settings: a link could come from anywhere, so
        // it is asked here, over whatever was showing, and never repoints the app on its own.
        .onOpenURL { url in
            let offer = Offer(server: Pairing(link: url), life: LifePairing(link: url))
            if !offer.isEmpty { dismissSheet { confirming = offer } }
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
        .tint(Palette.redText)
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

    /// Runs `then` once no sheet is up, dismissing the one that is.
    private func dismissSheet(then: @escaping () -> Void) {
        let presented = UIApplication.shared.connectedScenes.lazy
            .compactMap { ($0 as? UIWindowScene)?.keyWindow?.rootViewController?.presentedViewController }.first
        guard let presented else { return then() }
        presented.dismiss(animated: true, completion: then)
    }
}
