import SwiftUI

/// The notice at the top of the thread: "Your Mac isn't answering" while Life cannot be reached (it unfolds to the
/// phone's own settings, as a settings block), then, once, "Back" with how many of his answers went when it was.
struct Notices: View {
    @Environment(LifeStore.self) private var life
    let openSettings: () -> Void
    @State private var isOpen = false
    /// When this phone first found Life out of reach, for a path that is gone (a read says it itself otherwise).
    @State private var seenAt: Date?

    var body: some View {
        VStack(spacing: Metrics.Spacing.s) {
            if life.isOutOfReach {
                NoticeBlock(
                    title: title,
                    message: life.isOffline
                        ? "Nothing is lost; it goes when you're back online"
                        : "Nothing is lost; it goes when your Mac is back",
                    symbol: life.isOffline ? "wifi.slash" : "desktopcomputer",
                    isOpen: isOpen, toggle: { withAnimation(Motion.standard) { isOpen.toggle() } },
                    id: AID.noticeOutOfReach
                ) {
                    LiveSettingsBlock(keys: ["faceid", "pair"], openSettings: openSettings)
                }
                .transition(Motion.appears)
            } else if let back = life.caughtUp {
                Text(back.sent == 0 ? "Back" : "Back · \(back.sent) sent").font(.line).foregroundStyle(Palette.muted)
                    .accessibilityIdentifier(AID.noticeBack)
                    .task {
                        try? await Task.sleep(for: .seconds(4))
                        life.clearCaughtUp()
                    }
            }
        }
        .animation(Motion.standard, value: life.isOutOfReach)
        .onChange(of: life.isOutOfReach, initial: true) { seenAt = life.isOutOfReach ? seenAt ?? life.now() : nil }
    }

    /// One sentence: what is wrong, and since when.
    private var title: String {
        let what = life.isOffline ? "You're offline" : "Your Mac isn't answering"
        guard let since = life.lostSince ?? seenAt else { return what }
        return "\(what) · since \(since.clock)"
    }
}
