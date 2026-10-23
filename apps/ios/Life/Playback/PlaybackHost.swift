import Library
import SwiftUI
import Timeline

extension View {
    /// Hands the app-wide `PlaybackStore` (from the environment) the library, and shows the mini player above the tab bar while something is
    /// loaded and no conversation page (with its own player) is on screen. Tapping the mini player opens the
    /// conversation.
    func playbackHost() -> some View { modifier(PlaybackHost()) }
}

private struct PlaybackHost: ViewModifier {
    private static let player = "mini player"
    @Environment(PlaybackStore.self) private var playback
    @Environment(SyncStore.self) private var sync
    @Environment(\.library) private var library
    @State private var showsConversation = false
    @Namespace private var handoff
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .tabViewBottomAccessory(isEnabled: playback.item != nil && playback.pagesOnScreen == 0) {
                MiniPlayer { showsConversation = true }
                    .matchedTransitionSource(id: Self.player, in: handoff)
            }
            .sheet(isPresented: $showsConversation) {
                if let id = playback.item?.id {
                    let page = NavigationStack {
                        ConversationView(id: id, at: nil)
                            .id(id)
                            .toolbar {
                                ToolbarItem(placement: .cancellationAction) {
                                    Button("Close") { showsConversation = false }
                                }
                            }
                    }
                    // The page grows out of the mini player and shrinks back into it.
                    if reduceMotion {
                        page
                    } else {
                        page.navigationTransition(.zoom(sourceID: Self.player, in: handoff))
                    }
                }
            }
            .onChange(of: playback.item == nil) { _, stopped in if stopped { showsConversation = false } }
            .task {
                playback.sync = sync
                playback.library = library
            }
    }
}

/// The compact player above the tab bar: title and where it is, play/pause, a 15 s skip and close. When the tab bar
/// minimizes it keeps only the title and play/pause. The full controls float over the conversation itself.
struct MiniPlayer: View {
    @Environment(PlaybackStore.self) private var playback
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement
    let open: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            Button(action: open) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(playback.item?.title ?? "")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.textPrimary)
                    if placement != .inline { MiniElapsed() }
                }
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the conversation")
            PlayPauseButton()
            if placement != .inline {
                Button("Forward 15 seconds", systemImage: "goforward.15") {
                    playback.skip(by: PlaybackStore.skipMillis)
                }
            }
            Button("Stop playback", systemImage: "xmark") { playback.stop() }
                .foregroundStyle(Palette.textSecondary)
                .accessibilityIdentifier("miniPlayer.stop")
        }
        .labelStyle(.iconOnly)
        .foregroundStyle(Palette.textPrimary)
        .padding(.horizontal, 16)
        // The tab bar's accessory has a fixed height: past this size the title and controls no longer fit in it. The
        // conversation page, one tap away, shows everything at any size.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    }
}

/// "04:07 / 11:00". Alone in reading the position, so the rest of the mini player stays still.
private struct MiniElapsed: View {
    @Environment(PlaybackStore.self) private var playback

    var body: some View {
        if let item = playback.item {
            let elapsed = playback.position.map(item.range.lowerBound.distance(to:)) ?? 0
            Text("\(PlayerClock.string(elapsed)) / \(PlayerClock.string(item.range.millis))")
                .font(.monoSmall)
                .foregroundStyle(Palette.textSecondary)
                .accessibilityLabel("\(PlayerClock.spoken(elapsed)) of \(PlayerClock.spoken(item.range.millis))")
        }
    }
}
