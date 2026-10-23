#if DEBUG
    import Foundation
    import Library
    import ServerAPI
    import SwiftUI
    import Timeline

    /// The fixture conversations in a temporary library's cache, for previews only. No audio: the simulator fixture
    /// library covers playback.
    enum PreviewLibrary {
        static func make(seeded: Bool) async throws -> LibraryStore {
            let library = try LibraryStore(directory: .temporaryDirectory.appending(path: "preview-\(UUID())"))
            if seeded { try await library.apply(feed: FixtureLibrary.page(FixtureLibrary.layouts())) { _ in } }
            return library
        }
    }

    /// Opens a preview library, then shows `content` for it.
    struct LibraryPreview<Content: View>: View {
        var seeded = true
        @ViewBuilder let content: (LibraryStore) -> Content
        @State private var library: LibraryStore?

        var body: some View {
            if let library {
                content(library)
            } else {
                ProgressView().task { library = try? await PreviewLibrary.make(seeded: seeded) }
            }
        }
    }

    /// One tab's list over the cache, without the driver: a merge does nothing.
    private func listStore(_ library: LibraryStore) -> LibraryListStore {
        LibraryListStore(library: library, sync: nil, meaningSearch: nil)
    }

    /// The designed screens are dark only.
    private func journal(_ store: LibraryListStore, isSelecting: Bool = false, query: String = "") -> some View {
        LibraryScreen(store: store, path: .constant([]), isSelecting: isSelecting, query: query)
            .previewSync()
            .preferredColorScheme(.dark)
    }

    #Preview("Conversations") {
        LibraryPreview { journal(listStore($0)) }
    }

    #Preview("Row states") {
        let start = Date.now.addingTimeInterval(-3_600)
        let rows: [ConversationRow] = [
            ConversationRow(local: CaptureInstant(start)..<CaptureInstant(start.addingTimeInterval(240))),
            ConversationRow(id: UUID(), start: start, end: start + 300, state: .notUploaded),
            ConversationRow(id: UUID(), start: start, end: start + 300, state: .uploaded),
            ConversationRow(id: UUID(), start: start, end: start + 300, state: .transcribing),
            ConversationRow(
                id: UUID(), title: "Coffee with Mai", opening: "Morning Mai, did you sleep well?", start: start,
                end: start + 660, people: ["Mai"], place: "Oakridge 21", state: .transcribed, waiting: .macAway),
            ConversationRow(
                id: UUID(), title: "Condo call with Somchai", summary: "Somchai quoted 45,000 baht for the pipes.",
                start: start, end: start + 300, people: ["Somchai"], state: .summarized,
                editWaiting: true),
            ConversationRow(id: UUID(), start: start, end: start + 20, state: .transcribed),
        ]
        List(rows) { ConversationRowView(row: $0).listRowBackground(Palette.ground) }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Palette.ground)
            .preferredColorScheme(.dark)
    }

    #Preview("Selecting") {
        LibraryPreview { journal(listStore($0), isSelecting: true) }
    }

    #Preview("Accessibility text") {
        LibraryPreview { journal(listStore($0)) }
            .environment(\.dynamicTypeSize, .accessibility3)
    }

    #Preview("Empty") {
        LibraryPreview(seeded: false) { journal(listStore($0)) }
    }

    #Preview("Loading") {
        LibraryLoadingRows()
            .previewSync()
            .preferredColorScheme(.dark)
    }

    #Preview("Failed") {
        LibraryMessage(
            title: "Couldn’t load the library", systemImage: "exclamationmark.triangle",
            description: "The database is locked."
        ) {
            Button("Try again") {}
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.ground)
        .preferredColorScheme(.dark)
    }

    #Preview("Search results") {
        LibraryPreview { library in
            journal(listStore(library), query: "dinner")
        }
    }

    #Preview("Search too short") {
        LibraryPreview { library in
            journal(listStore(library), query: "di")
        }
    }

    #Preview("Nothing found") {
        LibraryPreview { library in
            journal(listStore(library), query: "zanzibar")
        }
    }

    #Preview("Not open") {
        LibraryView(store: nil, path: .constant([]))
            .previewSync()
            .preferredColorScheme(.dark)
    }

    #Preview("People") {
        LibraryPreview { library in
            NavigationStack { PeopleView(library: library) }
                .preferredColorScheme(
                    .dark)
        }
    }

    #Preview("No people") {
        LibraryPreview(seeded: false) { library in
            NavigationStack { PeopleView(library: library) }
                .preferredColorScheme(
                    .dark)
        }
    }
#endif
