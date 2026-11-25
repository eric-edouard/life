import Incidents
import LifeConnector
import SwiftUI
import UIKit

/// The shell until the chat (P2): a Pendant sheet, Settings, and pairing. The old screens are gone.
struct RootView: View {
    @Environment(SyncStore.self) private var sync
    @Environment(LifeStore.self) private var life
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    @AppStorage("appearance") private var appearance = Appearance.auto
    @State private var isPendantShown = false
    @State private var isSettingsShown = false
    /// A pairing link the owner is asked to confirm: the lifelog server, Life, or both.
    @State private var confirming: PairOffer?

    var body: some View {
        VStack(spacing: 24) {
            Button("Pendant") { isPendantShown = true }
            Button("Settings") { isSettingsShown = true }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(isPresented: $isPendantShown) { PendantView().sheetStack() }
        .sheet(isPresented: $isSettingsShown) { NavigationStack { SettingsPage() }.sheetStack() }
        .sheet(item: $confirming) { PairSheet(offer: $0).sheetStack() }
        .environment(\.windowSizeClass, sizeClass)
        .preferredColorScheme(appearance.scheme)
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            sync.becameActive()
            await life.refreshOnForeground()
        }
        // A pairing link (`lifelog://pair?...`), from the Camera or pasted in Settings: it is asked here, never applied alone.
        .onOpenURL { url in
            if let offer = PairOffer(link: url) { confirming = offer }
        }
        .font(.body15)
        .tint(Palette.fg)
    }
}

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
