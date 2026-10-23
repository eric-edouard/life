#if DEBUG
    import Library
    import SwiftUI
    import Timeline

    /// The players over a fixture conversation, paused a third of the way in. No audio behind them.
    private enum PlayerPreview {
        static let record = FixtureLayout(FixtureConversation.all[0], now: .now, people: [:]).conversation

        static func playback(status: PlaybackStore.Status = .ready) -> PlaybackStore {
            let third = record.range.lowerBound.advanced(by: record.range.millis / 3)
            return .preview(record, at: third, status: status)
        }

        static func reader(_ playback: PlaybackStore) -> some View {
            VStack {
                Spacer()
                ReaderPlayer(id: record.id, range: record.range) { _, _ in }
                    .padding()
            }
            .background(Palette.ground)
            .environment(playback)
            .preferredColorScheme(.dark)
        }
    }

    #Preview("Player") { PlayerPreview.reader(PlayerPreview.playback()) }
    #Preview("Player, nothing loaded") { PlayerPreview.reader(.preview()) }
    #Preview("Player, no audio") {
        PlayerPreview.reader(PlayerPreview.playback(status: .unavailable("No audio for this conversation yet.")))
    }
    #Preview("Player, large text") {
        PlayerPreview.reader(PlayerPreview.playback()).dynamicTypeSize(.accessibility3)
    }

    #Preview("Mini player") {
        TabView {
            Tab("Library", systemImage: "books.vertical") { Color.clear }
        }
        .tabViewBottomAccessory { MiniPlayer {} }
        .environment(PlayerPreview.playback())
        .preferredColorScheme(.dark)
    }
#endif
