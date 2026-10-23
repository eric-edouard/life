import ServerAPI
import SwiftUI

/// The owner's names and words, sent as hints with each transcription so they come back spelled right. The list is
/// the feed's (`vocabulary`), so it shows at once and offline. A change goes through the outbox as the whole list and
/// shows at once, waiting to sync. Nothing can be changed before the feed said: a change replaces the whole list.
struct VocabularyView: View {
    @Environment(SyncStore.self) private var sync
    @State private var draft = ""

    /// A change waiting for the server wins over what the feed said.
    private var terms: [String]? { sync.pending.vocabulary ?? sync.feed.vocabulary }

    var body: some View {
        List {
            if let terms {
                Section {
                    TextField("Add a name or word", text: $draft)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit { add(to: terms) }
                        .accessibilityIdentifier("vocabulary.add")
                    ForEach(terms, id: \.self) { Text($0) }
                        .onDelete { offsets in
                            var kept = terms
                            kept.remove(atOffsets: offsets)
                            save(kept)
                        }
                } footer: {
                    VStack(alignment: .leading, spacing: 8) {
                        if sync.pending.vocabulary != nil {
                            Label("Waiting to sync", systemImage: "arrow.triangle.2.circlepath")
                                .labelStyle(.decorativeIcon)
                        }
                        Text(
                            "Sent with each new transcription so these come back spelled right. The names of your people go on their own. Audio already transcribed keeps its words."
                        )
                    }
                }
            } else {
                ContentUnavailableView {
                    Label("Your words aren't here yet", systemImage: "icloud")
                } description: {
                    Text("They show once Life has synced with the server.")
                }
                .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Palette.ground)
        .navigationTitle("Vocabulary")
    }

    private func add(to terms: [String]) {
        let term = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        draft = ""
        guard !term.isEmpty, !terms.contains(term) else { return }
        save([term] + terms)
    }

    private func save(_ terms: [String]) {
        Task { await sync.perform(.vocabulary(terms)) }
    }
}

#if DEBUG
    #Preview("Not synced yet") {
        NavigationStack { VocabularyView() }
            .previewSync()
            .preferredColorScheme(.dark)
    }
#endif
