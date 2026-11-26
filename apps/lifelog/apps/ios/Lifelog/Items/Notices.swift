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
                    title: life.isOffline ? "You're offline" : "Your Mac isn't answering",
                    message: line,
                    symbol: life.isOffline ? "wifi.slash" : "desktopcomputer",
                    isOpen: isOpen, toggle: { Motion.animate { isOpen.toggle() } },
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

    /// "Nothing is lost · since 14:10": the prototype's line under the title.
    private var line: String {
        guard let since = life.lostSince ?? seenAt else { return "Nothing is lost" }
        return "Nothing is lost · since \(since.clock)"
    }
}
