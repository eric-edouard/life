import SwiftUI

/// The notice at the end of the thread (the prototype's `.sys`): "You're offline" or "Your Mac isn't answering" while Life
/// cannot be reached, with the phone's own settings under it, then, once, "Back" with how many of his answers went.
/// No tap and not in the count.
struct Notices: View {
    @Environment(LifeStore.self) private var life
    let openSettings: () -> Void
    /// When this phone first found Life out of reach, for a path that is gone (a read says it itself otherwise).
    @State private var seenAt: Date?
    /// What the notice said while it stood, so it settles in place with the same title and mark.
    @State private var was: (title: String, mark: Glyph.Mark)?

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            if life.isOutOfReach {
                let title = life.isOffline ? "You're offline" : "Your Mac isn't answering"
                let mark: Glyph.Mark = life.isOffline ? .offline : .mac
                NoticeBlock(
                    title: title, message: line, mark: mark, isOpen: true, id: AID.noticeOutOfReach
                ) {
                    LiveSettingsBlock(
                        keys: life.isOffline ? ["faceid"] : ["faceid", "pair"], openSettings: openSettings)
                }
                .transition(Motion.appears)
                .onAppear { was = (title, mark) }
                .onChange(of: title) { was = (title, mark) }
            } else if let back = life.caughtUp, let was {
                NoticeBlock(
                    title: was.title,
                    message: back.sent == 0 ? "Back · caught up" : "Back online · \(back.sent) sent",
                    isSettled: true, mark: was.mark
                )
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(back.sent == 0 ? "Back · caught up" : "Back online · \(back.sent) sent")
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

    /// The prototype's line under the title: what he does waits (or how many wait), and since when.
    private var line: String {
        let waiting = life.queued.entries.count
        let what =
            life.isOffline
            ? (waiting > 0 ? "\(waiting) waiting to go" : "What you do waits") : "Nothing is lost"
        guard let since = life.lostSince ?? seenAt else { return what }
        return "\(what) · since \(since.clock)"
    }
}
