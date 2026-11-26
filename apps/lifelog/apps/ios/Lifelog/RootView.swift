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
    /// A pairing is being checked (`PairSheet`): another pairing link waits for it.
    @State private var isPairing = false
    /// A pairing link that came while a sheet was up: asked once that sheet has gone.
    @State private var pendingPair: PairOffer?

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

    /// The field, as tall as it is now: the thread keeps its last row clear of it.
    @State private var fieldHeight: CGFloat = 0
    /// The two round buttons and the notices over the thread: it starts below them.
    @State private var topHeight: CGFloat = 0
    @State private var noticeHeight: CGFloat = 0
    @State private var screenHeight: CGFloat = 800

    private struct Profile: Hashable { let ref: String }
    @Namespace private var profileZoom

    private var thread: LifeThread { life.thread }
    /// What he sees now, as refs only: the thread, or the profile pushed over it.
    private var screen: MainSessionScreen { MainSessionScreen(open: profiles.last?.ref ?? life.opened, tab: "thread") }
    private var edge: EdgeState {
        life.isOutOfReach ? .still : thread.isWorking ? .working : isSpeaking ? .speaking : .rest
    }

    var body: some View {
        NavigationStack(path: $profiles) {
            ZStack {
                Palette.bg.ignoresSafeArea()
                if life.isPaired {
                    ThreadView(
                        thread: thread, screen: screen, actions: actions, topHeight: topHeight, fieldHeight: fieldHeight
                    )
                } else {
                    Button("Pair Life") { sheet = .settings }.buttonStyle(.pill(.filled, size: .compact)).padding(
                        Metrics.Spacing.xxl)
                }
            }
            // An overlay, not an inset: an inset that fills the height (as this one did) leaves the thread only what is
            // left under it, and its top fade then covers the wrong strip.
            .overlay(alignment: .top) {
                VStack(spacing: Metrics.Spacing.s) {
                    buttons
                    // The notice, opened, grows to its words up to half of the screen, then scrolls: the buttons above it
                    // always stay in view, at the largest text size too.
                    ScrollView {
                        Notices { sheet = .settings }.padding(.horizontal, Metrics.Spacing.l)
                            .onGeometryChange(for: CGFloat.self) {
                                $0.size.height
                            } action: {
                                noticeHeight = $0
                            }
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(height: min(noticeHeight, screenHeight * 0.5))
                }
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) {
                    $0.size.height
                } action: {
                    topHeight = $0
                }
            }
            .onGeometryChange(for: CGFloat.self) {
                $0.size.height
            } action: {
                screenHeight = $0
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Profile.self) {
                ProfileView(ref: $0.ref).zooms(from: $0.ref, in: profileZoom)
            }
        }
        // The field is on every screen, a pushed profile too: it asks with that screen's refs.
        .safeAreaInset(edge: .bottom) {
            AskField(
                text: $text, isWorking: thread.isWorking, isSpeaking: $isSpeaking, isFocused: $isAsking, send: send
            ) {
                Task { await thread.stop() }
            }
            .padding(.horizontal, Metrics.Spacing.l).padding(.bottom, Metrics.Spacing.s)
            .onGeometryChange(for: CGFloat.self) {
                $0.size.height
            } action: {
                fieldHeight = $0
            }
        }
        // The ring is round the whole screen, a pushed profile too; a sheet covers it.
        .overlay { EdgeView(state: edge) }
        .sheet(
            item: $sheet,
            onDismiss: {
                if let offer = pendingPair {
                    pendingPair = nil
                    sheet = .pair(offer)
                }
            }
        ) { sheet in
            switch sheet {
            case .pendant: PendantView().sheetStack()
            case .settings: SettingsPage().toolbar { CloseItem { self.sheet = nil } }.sheetStack()
            case .link(let ref): LinkSheet(ref: ref)
            case .pair(let offer): PairSheet(offer: offer, isPairing: $isPairing).sheetStack()
            }
        }
        .environment(\.windowSizeClass, sizeClass).environment(\.profileZoom, profileZoom)
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
        // The ask he was sent to is let go once it is answered or settled.
        .onChange(of: life.focused.flatMap(life.ask)?.state) { old, new in
            if old != nil, let new, [.underWay, .settled, .outdated].contains(new) { life.clearFocus() }
        }
        .onChange(of: life.isOutOfReach) { if !life.isOutOfReach { Task { await life.flushQueued() } } }
        // `lifelog://pair?...` (from the Camera or pasted in Settings) is asked here, never applied alone;
        // `lifelog://open?ref=...` opens a `life:` ref (`LinkAction`).
        .onOpenURL { url in
            let offer = PairOffer(link: url)
            switch LinkAction(url: url, isPairLink: offer != nil, isPairing: isPairing) {
            case .pair:
                guard let offer else { return }
                // Over an open sheet: it goes first, and the pairing is presented when it has gone.
                if sheet == nil {
                    sheet = .pair(offer)
                } else {
                    pendingPair = offer
                    sheet = nil
                }
            case .open(let ref): open(ref)
            case .ignore: break
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
        BlockActions(
            say: {
                thread.ask($0, screen: screen); return true
            }, openSettings: { sheet = .settings })
    }

    private func send() {
        life.clearFocus()
        thread.ask(text, screen: screen)
        text = ""
    }

    private var isRecording: Bool {
        if case .recording = capture.status.recording { true } else { false }
    }

    /// The two round buttons: what waits on him (its count; tap asks Life), and the pendant (long press: Settings).
    private var buttons: some View {
        HStack {
            Button {
                thread.ask("What's waiting on me?", screen: screen)
            } label: {
                // Something broken turns the count into a coral mark: he learns of it where he is (the lab's Settings 2, B).
                Group {
                    if life.isOutOfReach {
                        Image(systemName: "exclamationmark").font(.rowTitle).foregroundStyle(Palette.flag)
                    } else {
                        Text(life.waitingCount.map(String.init) ?? "").font(.rowTitle)
                    }
                }
                .frame(width: Metrics.tapTarget, height: Metrics.tapTarget)
            }
            .accessibilityLabel(life.isOutOfReach ? "Life can't be reached" : "What's waiting on me")
            Spacer()
            Button {
                sheet = .pendant
            } label: {
                // The prototype's dot: lit and breathing while it records, a hollow ring otherwise.
                Group {
                    if isRecording {
                        StateDot(color: Palette.fg, isLit: true)
                    } else {
                        Circle().strokeBorder(Palette.muted, lineWidth: 1.6).frame(
                            width: Metrics.dot, height: Metrics.dot)
                    }
                }
                .frame(width: Metrics.tapTarget, height: Metrics.tapTarget)
            }
            .contextMenu { Button("Settings") { sheet = .settings } }
            .accessibilityLabel(isRecording ? "Pendant, recording" : "Pendant, not recording")
        }
        .buttonStyle(.glass).buttonBorderShape(.circle).padding(.horizontal, Metrics.Spacing.l)
    }
}
