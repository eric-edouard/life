import Foundation
import Library
import Observation
import ServerAPI

/// People feature store: the feed's people from the cache, with the owner's corrections (rename, other names, merge),
/// which go through the outbox and show at once. The voices still to name are `NamingQueue`'s. Nothing here deletes a
/// recording.
@Observable
final class PeopleStore {
    enum Phase: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    private(set) var phase = Phase.loading
    private(set) var people: [CachedPerson] = []
    /// People with a correction waiting for the server.
    private(set) var waiting: Set<UUID> = []
    /// A correction that couldn't be kept, for the owner to read.
    var actionError: String?

    @ObservationIgnored private let sync: SyncStore?
    @ObservationIgnored private let library: LibraryStore

    init(library: LibraryStore, sync: SyncStore?) {
        self.library = library
        self.sync = sync
    }

    /// Moves when the feed brought new rows: the page reads again.
    var generation: Int { sync?.generation ?? 0 }

    func load() async {
        do {
            let pending = sync?.pending ?? PendingEdits([])
            people = pending.people(over: try await library.people())
            waiting = pending.people
            phase = .loaded
        } catch {
            phase = .failed(report(error))
        }
    }

    /// The name and the other names ("Mamie, Jojo") as the owner typed them, the others comma-separated: what changed
    /// goes to the server. Summaries, the assistant and "Who's this?" know the other names.
    func edit(_ person: CachedPerson, name: String, aliases: String) async {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty, name != person.name { await perform(.renamePerson(person.id, name: name)) }
        let aliases = aliases.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter {
            !$0.isEmpty
        }
        if aliases != person.aliases ?? [] { await perform(.aliases(person.id, aliases)) }
    }

    /// `person`'s voice evidence and assignments move to `target`; `person` is gone. Recordings stay.
    func merge(_ person: CachedPerson, into target: CachedPerson) async {
        await perform(.mergePerson(person.id, into: target.id))
    }

    private func perform(_ intent: OwnerIntent) async {
        guard let sync else { return }
        actionError = await sync.perform(intent)
        await load()
    }
}
