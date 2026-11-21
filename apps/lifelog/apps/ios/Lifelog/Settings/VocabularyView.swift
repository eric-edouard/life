import ServerAPI
import SwiftUI

/// The owner's names and words, sent as hints with each transcription so they come back spelled right. The list is
/// the feed's (`vocabulary`), so it shows at once and offline. A change goes through the outbox as the whole list and
/// shows at once; a refused one goes back with its reason (`ServerValue`). Nothing can be changed before the feed said: a
/// change replaces the whole list.
struct VocabularyView: View {
    @Environment(SyncStore.self) private var sync
    @State private var draft = ""

    private var words: ServerValue<[String]> { serverVocabulary(feed: sync.feed.vocabulary, pending: sync.pending) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if let terms = words.shown {
                    VStack(alignment: .leading, spacing: 12) {
                        // Its Send adds the word: the one submit is the field's.
                        Field(prompt: "Add a word or a name", text: $draft, surface: .sheet) { add(to: terms) }
                            .autocorrectionDisabled()
                            .submitLabel(.done)
                            .onSubmit { add(to: terms) }
                            .accessibilityIdentifier("vocabulary.add")
                        Text("Used from the next recording.").font(.note).foregroundStyle(Palette.muted)
                        switch words {
                        case .saving:
                            HStack(spacing: 8) {
                                StateGlyph.busy; Text("Saving…").font(.small).foregroundStyle(Palette.muted)
                            }
                        case .refused(_, let message): Text(message).font(.small).foregroundStyle(Palette.flag)
                        case .known, .asking: EmptyView()
                        }
                    }
                    if !terms.isEmpty {
                        RowGroup(label: terms.count == 1 ? "1 word" : "\(terms.count) words", surface: .sheet) {
                            ForEach(terms, id: \.self) { term in
                                Row(title: term) {
                                    Button {
                                        save(terms.filter { $0 != term })
                                    } label: {
                                        Image(systemName: "xmark").font(.system(size: 14, weight: .semibold))
                                            .foregroundStyle(Palette.muted).frame(width: 44, height: 44)
                                    }
                                    .accessibilityLabel("Remove \(term)")
                                }
                            }
                        }
                    }
                } else {
                    RowGroup(surface: .sheet) { Row(title: "Your words", state: .asking) }
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 8)
            .padding(.bottom, 24)
            .readingWidth()
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.sheet)
        .navigationTitle("Vocabulary")
    }

    private var typed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func add(to terms: [String]) {
        let term = typed
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
