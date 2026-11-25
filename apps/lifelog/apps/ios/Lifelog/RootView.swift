import Incidents
import LifeConnector
import SwiftUI
import UIKit

/// The whole app: the thread, the field at the bottom, the edge, and two round buttons at the top (what waits on him,
/// the pendant). No tab bar and no other screen; the rest opens over it.
struct RootView: View {
    @Environment(SyncStore.self) private var sync
    @Environment(LifeStore.self) private var life
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    @AppStorage("appearance") private var appearance = Appearance.auto
    @State private var isPendantShown = false
    @State private var isSettingsShown = false
    @State private var text = ""
    @State private var isSpeaking = false
    /// A pairing link the owner is asked to confirm: the lifelog server, Life, or both.
    @State private var confirming: PairOffer?

    private var thread: LifeThread { life.thread }
    /// What he sees now, as refs only: the thread is the one screen.
    private let screen = MainSessionScreen(tab: "thread")
    private var edge: EdgeState {
        life.isOutOfReach ? .still : thread.isWorking ? .working : isSpeaking ? .speaking : .rest
    }

    var body: some View {
        ZStack {
            Palette.bg.ignoresSafeArea()
            if life.isPaired {
                ThreadView(thread: thread, screen: screen, actions: actions)
                    .safeAreaPadding(.top, 56).safeAreaPadding(.bottom, 8)
            } else {
                Button("Pair Life") { isSettingsShown = true }.buttonStyle(.pill(.filled, size: .compact)).padding(80)
            }
            EdgeView(state: edge)
        }
        .safeAreaInset(edge: .top) { buttons }
        .safeAreaInset(edge: .bottom) {
            AskField(text: $text, isWorking: thread.isWorking, isSpeaking: $isSpeaking, send: send) {
                Task { await thread.stop() }
            }
            .padding(.horizontal, Metrics.Spacing.l).padding(.bottom, Metrics.Spacing.s)
        }
        .sheet(isPresented: $isPendantShown) { PendantView().sheetStack() }
        .sheet(isPresented: $isSettingsShown) { NavigationStack { SettingsPage() }.sheetStack() }
        .sheet(item: $confirming) { PairSheet(offer: $0).sheetStack() }
        .environment(\.windowSizeClass, sizeClass)
        .preferredColorScheme(appearance.scheme)
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            sync.becameActive()
            await life.refreshOnForeground()
            await thread.sendWaiting(screen: screen)
            await thread.keepWarm()
        }
        // A pairing link (`lifelog://pair?...`), from the Camera or pasted in Settings: it is asked here, never applied alone.
        .onOpenURL { url in
            if let offer = PairOffer(link: url) { confirming = offer }
        }
        .font(.body15)
        .tint(Palette.fg)
    }

    private var actions: BlockActions {
        BlockActions(say: { thread.ask($0, screen: screen) }, openSettings: { isSettingsShown = true })
    }

    private func send() {
        thread.ask(text, screen: screen)
        text = ""
    }

    /// The two round buttons: what waits on him (its count; tap asks Life), and the pendant (long press: Settings).
    private var buttons: some View {
        HStack {
            Button {
                thread.ask("What's waiting on me?", screen: screen)
            } label: {
                Text(life.waitingCount.map(String.init) ?? "·").font(.rowName).frame(width: 44, height: 44)
            }
            .accessibilityLabel("What's waiting on me")
            Spacer()
            Button {
                isPendantShown = true
            } label: {
                Image(systemName: "waveform").frame(width: 44, height: 44)
            }
            .contextMenu { Button("Settings") { isSettingsShown = true } }
            .accessibilityLabel("Pendant")
        }
        .buttonStyle(.glass).buttonBorderShape(.circle).padding(.horizontal, Metrics.Spacing.l)
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
