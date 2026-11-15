import Library
import SwiftUI

/// People the owner has named or recognition has met, the corrections the owner can make (rename with the other
/// names, merge), and the way to the voices still to name.
struct PeopleView: View {
    @State private var store: PeopleStore
    @State private var editing: CachedPerson?
    @State private var draftName = ""
    @State private var draftAliases = ""
    @State private var merging: Merge?
    @Environment(NamingQueue.self) private var naming: NamingQueue?

    struct Merge {
        var person: CachedPerson
        var target: CachedPerson
    }

    /// The page owns its store: built from these once, when it first appears.
    init(library: LibraryStore, sync: SyncStore? = nil) {
        store = PeopleStore(library: library, sync: sync)
    }

    var body: some View {
        List {
            if let naming, let first = naming.next {
                Section {
                    NamingEntry(count: naming.count, first: first)
                        .listRowBackground(Palette.surface2)
                }
            }
            if !store.people.isEmpty {
                Section {
                    ForEach(store.people) { person in
                        PersonRow(
                            person: person, waiting: store.waiting.contains(person.id),
                            others: store.people.filter { $0.id != person.id },
                            edit: {
                                draftName = person.name
                                draftAliases = (person.aliases ?? []).joined(separator: ", ")
                                editing = person
                            },
                            merge: { merging = Merge(person: person, target: $0) }
                        )
                        .listRowBackground(Palette.surface1)
                    }
                } header: {
                    Text("People").foregroundStyle(Palette.textSecondary)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Palette.ground)
        .overlay {
            switch store.phase {
            case .loading: ProgressView("Loading people").foregroundStyle(Palette.textSecondary)
            case .failed(let error):
                LibraryMessage(
                    title: "Couldn’t load people", systemImage: "exclamationmark.triangle", description: error
                ) {
                    Button("Try again") { Task { await store.load() } }
                }
            case .loaded where store.people.isEmpty && (naming?.voices.isEmpty ?? true):
                LibraryMessage(
                    title: "No people yet", systemImage: "person.2",
                    description: "Name a speaker in a conversation and they appear here.")
            case .loaded: EmptyView()
            }
        }
        .navigationTitle("People")
        .task(id: store.generation) { await store.load() }
        .task { await naming?.refresh() }
        .refreshable {
            await store.load()
            await naming?.refresh()
        }
        .timesFirstRender("people", ready: store.phase == .loaded, rows: store.people.count)
        .alert("Edit", item: $editing) { person in
            TextField("Name", text: $draftName)
            TextField("Also called (Mamie, Jojo)", text: $draftAliases)
            Button("Save") { Task { await store.edit(person, name: draftName, aliases: draftAliases) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Summaries, your assistant and Who’s this? know the other names.")
        }
        .confirmationDialog("Merge people?", item: $merging) { merge in
            Button("Merge into \(merge.target.name)") { Task { await store.merge(merge.person, into: merge.target) } }
        } message: { merge in
            Text(
                "\(merge.person.name) becomes \(merge.target.name): their voice samples and every conversation they "
                    + "were named in move over. Recordings are kept.")
        }
        .alert("Something went wrong", item: $store.actionError) { _ in
            Button("OK") {}
        } message: { error in
            Text(error)
        }
    }
}

/// The way to the voices to name: how many, and the first one's words.
private struct NamingEntry: View {
    let count: Int
    let first: NamingQueue.Voice

    var body: some View {
        NavigationLink(value: LibraryRoute.naming) {
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Who’s this?")
                        .font(.cardTitle)
                        .foregroundStyle(Palette.textPrimary)
                    Group {
                        if count > 0 {
                            Text("^[\(count) voice](inflect: true) you talked with this month")
                        } else {
                            Text("Names to check again")
                        }
                    }
                    .font(.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                }
                if let words = first.clips.first?.item.text {
                    Text("“\(words)”")
                        .font(.spokenQuote)
                        .foregroundStyle(Palette.textBody)
                        .lineLimit(2)
                }
            }
            .padding(.vertical, 8)
        }
        .accessibilityIdentifier("people.naming")
    }
}

private struct PersonRow: View {
    let person: CachedPerson
    let waiting: Bool
    let others: [CachedPerson]
    let edit: () -> Void
    let merge: (CachedPerson) -> Void

    var body: some View {
        Menu {
            Button("Rename", systemImage: "pencil", action: edit)
            if !others.isEmpty {
                Menu("Merge into", systemImage: "arrow.triangle.merge") {
                    ForEach(others) { other in
                        Button(other.name) { merge(other) }
                    }
                }
            }
        } label: {
            HStack(spacing: 12) {
                Text(person.name.prefix(1).uppercased())
                    .font(.rowTitle)
                    .foregroundStyle(Palette.textBody)
                    .frame(width: avatar, height: avatar)
                    .background(Palette.surface3, in: .circle)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(person.name)
                        .font(.rowTitle)
                        .foregroundStyle(Palette.textPrimary)
                    if let aliases = person.aliases, !aliases.isEmpty {
                        Text("Also \(aliases.formatted())")
                            .font(.caption)
                            .foregroundStyle(Palette.textSecondary)
                    }
                    if waiting {
                        Text("Waiting to sync").font(.caption).foregroundStyle(Palette.textTertiary)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(.rect)
        }
        .accessibilityHint("Rename or merge.")
    }

    @ScaledMetric(relativeTo: .title3) private var avatar: CGFloat = 36
}

/// The People page over the library opened at launch.
struct PeopleScreen: View {
    @Environment(\.library) private var library
    @Environment(SyncStore.self) private var sync: SyncStore?

    var body: some View {
        if let library {
            PeopleView(library: library, sync: sync)
        } else {
            LibraryMessage(title: "Library not open", systemImage: "tray", description: LibraryStore.notOpen)
        }
    }
}
