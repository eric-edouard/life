#if DEBUG
    import Foundation
    import Library
    import SwiftUI
    import Timeline

    /// One preview per conversation state, from the fixture script. No library, server or audio.
    private enum PreviewState {
        static func store(_ index: Int, state: ConversationState? = nil) -> ConversationStore {
            .preview(
                FixtureLayout(FixtureConversation.all[index], now: .now, people: FixtureLibrary.people), state: state)
        }

        static func view(_ store: ConversationStore, playback: PlaybackStore = .preview()) -> some View {
            NavigationStack { ConversationContent(store: store) }
                .environment(playback)
                .previewSync()
                .preferredColorScheme(.dark)
        }

        /// Paused a few passages in, so the spoken passage, the past ones and the player's position show.
        static func reading(_ store: ConversationStore) -> some View {
            let line = store.lines[min(4, store.lines.count - 1)]
            return view(store, playback: store.conversation.map { .preview($0, at: line.start) } ?? .preview())
        }
    }

    #Preview("Loading") { PreviewState.view(.preview(.loading)) }
    #Preview("Missing") { PreviewState.view(.preview(.missing)) }
    #Preview("Not uploaded yet") { PreviewState.view(PreviewState.store(3, state: .notUploaded)) }
    #Preview("Uploaded") { PreviewState.view(PreviewState.store(3, state: .uploaded)) }
    #Preview("Transcribing") { PreviewState.view(PreviewState.store(3, state: .transcribing)) }
    #Preview("Words so far") { PreviewState.view(PreviewState.store(0, state: .transcribing)) }
    #Preview("Transcribed, summary waiting") { PreviewState.view(PreviewState.store(2)) }
    #Preview("Summarized") { PreviewState.view(PreviewState.store(5)) }
    #Preview("Reading along") { PreviewState.reading(PreviewState.store(0)) }
    #Preview("Split by AI") { PreviewState.view(PreviewState.store(1)) }
    #Preview("Split here?") { PreviewState.view(PreviewState.store(0)) }
    #Preview("No words") { PreviewState.view(PreviewState.store(7, state: .transcribed)) }
    #Preview("Accessibility size") {
        PreviewState.reading(PreviewState.store(5)).dynamicTypeSize(.accessibility3)
    }
#endif
