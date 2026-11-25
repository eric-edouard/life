import Incidents
import LifeConnector
import SwiftUI
import UIKit

/// The whole app: the thread, the field at the bottom, the edge, and two round buttons at the top (what waits on him,
/// the pendant). No tab bar and no other screen; the rest opens over it.
struct RootView: View {
    @Environment(SyncStore.self) private var sync
    @Environment(LifeStore.self) private var life
    @Environment(CaptureStore.self) private var capture
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// The one sheet that may be up: opening another replaces it, a pairing link included.
    @State private var sheet: Sheet?
    /// What is pushed over the thread: a profile, one level deep.
    @State private var profiles: [Profile] = []
    @State private var text = ""
    @State private var isSpeaking = false
    @FocusState private var isAsking: Bool

    private enum Sheet: Identifiable {
        case pendant, settings, link(String)
        /// A pairing link the owner is asked to confirm: the lifelog server, Life, or both.
        case pair(PairOffer)

        var id: String {
            switch self {
            case .pendant: "pendant"
            case .settings: "settings"
            case .link(let ref): "link:" + ref
            case .pair(let offer): "pair:\(offer.id)"
            }
        }
    }

    private struct Profile: Hashable { let ref: String }

    private var thread: LifeThread { life.thread }
    /// What he sees now, as refs only: the thread is the one screen.
    private let screen = MainSessionScreen(tab: "thread")
    private var edge: EdgeState {
        life.isOutOfReach ? .still : thread.isWorking ? .working : isSpeaking ? .speaking : .rest
    }

    var body: some View {
        NavigationStack(path: $profiles) {
            ZStack {
                Palette.bg.ignoresSafeArea()
                if life.isPaired {
                    ThreadView(thread: thread, screen: screen, actions: actions)
                } else {
                    Button("Pair Life") { sheet = .settings }.buttonStyle(.pill(.filled, size: .compact)).padding(80)
                }
            }
            .safeAreaInset(edge: .top) {
                VStack(spacing: Metrics.Spacing.s) {
                    buttons
                    Notices { sheet = .settings }.padding(.horizontal, Metrics.Spacing.l)
                }
            }
            .safeAreaInset(edge: .bottom) {
                AskField(
                    text: $text, isWorking: thread.isWorking, isSpeaking: $isSpeaking, isFocused: $isAsking, send: send
                ) {
                    Task { await thread.stop() }
                }
                .padding(.horizontal, Metrics.Spacing.l).padding(.bottom, Metrics.Spacing.s)
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Profile.self) { ProfileView(ref: $0.ref) }
        }
        // The ring is round the whole screen, a pushed profile too; a sheet covers it.
        .overlay { EdgeView(state: edge) }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .pendant: PendantView().sheetStack()
            case .settings: SettingsPage().sheetStack()
            case .link(let ref): LinkSheet(ref: ref)
            case .pair(let offer): PairSheet(offer: offer).sheetStack()
            }
        }
        .environment(\.windowSizeClass, sizeClass)
        .preferredColorScheme(.dark)
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            sync.becameActive()
            await life.refreshOnForeground()
            await thread.sendWaiting(screen: screen)
            await thread.keepWarm()
        }
        // A new card's push reads the asks again; a tapped notification lands on the thread with its ask unfolded;
        // back in reach, the held answers go.
        .onChange(of: capture.cardPushes) { Task { await life.refreshItems() } }
        .onChange(of: capture.routeToOpen) {
            guard let route = capture.routeToOpen else { return }
            capture.routeToOpen = nil
            toThread()
            Task {
                if case .card(let pushId, _, _) = route {
                    await life.focus(pushId: pushId)
                } else {
                    await life.refreshItems()
                }
            }
        }
        .onChange(of: life.isOutOfReach) { if !life.isOutOfReach { Task { await life.flushQueued() } } }
        // `lifelog://pair?...` (from the Camera or pasted in Settings) is asked here, never applied alone;
        // `lifelog://open?ref=...` opens a `life:` ref.
        .onOpenURL { url in
            if let offer = PairOffer(link: url) {
                sheet = .pair(offer)
            } else if url.host == "open",
                let ref = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: {
                    $0.name == "ref"
                })?.value
            {
                open(ref)
            }
        }
        // A `life:` link in Life's words (`life-open:`, made by `[Inline].attributed`) opens here, wherever it is tapped.
        .environment(
            \.openURL,
            OpenURLAction { url in
                guard url.scheme == "life-open",
                    let ref = url.absoluteString.dropFirst("life-open:".count).removingPercentEncoding
                else { return .systemAction }
                open(ref)
                return .handled
            }
        )
        .font(.body15)
        .tint(Palette.fg)
    }

    /// Back to the thread, nothing open over it.
    private func toThread() {
        sheet = nil
        profiles = []
    }

    /// A `life:` ref: a person's profile is pushed (a sheet closes first); an ask unfolds in its row; the rest is Life's
    /// own page in a sheet.
    private func open(_ ref: String) {
        if life.ask(ref) != nil {
            toThread()
            life.focus(ref: ref)
        } else if ref.hasPrefix("person:") {
            sheet = nil
            profiles = [Profile(ref: ref)]
        } else {
            sheet = .link(ref)
        }
    }

    private var actions: BlockActions {
        BlockActions(say: { thread.ask($0, screen: screen) }, openSettings: { sheet = .settings })
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
                Text(life.waitingCount.map(String.init) ?? "·").font(.rowTitle).frame(width: 44, height: 44)
            }
            .accessibilityLabel("What's waiting on me")
            Spacer()
            Button {
                sheet = .pendant
            } label: {
                Image(systemName: "waveform").frame(width: 44, height: 44)
            }
            .contextMenu { Button("Settings") { sheet = .settings } }
            .accessibilityLabel("Pendant")
        }
        .buttonStyle(.glass).buttonBorderShape(.circle).padding(.horizontal, Metrics.Spacing.l)
    }
}
