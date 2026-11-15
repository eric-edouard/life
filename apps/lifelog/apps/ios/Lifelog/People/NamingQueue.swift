import Foundation
import Library
import Observation
import ServerAPI
import Timeline

/// The voices to name (`GET /naming-queue`), app-wide: the Library's row and badge, People's entry and the naming screen
/// all read this one list, in the server's order, so they show one number. The names to check again
/// (`GET /naming-queue/rechecks`) follow them on the screen, outside that number. The last list is kept on disk so the screen
/// opens at once and offline, as the morning push's tap expects; a refresh replaces it when the server answers. An
/// answer leaves the list and goes to the outbox at once, and the voices of answers waiting there stay out of it.
@Observable
final class NamingQueue {
    /// A stretch of a voice to hear, with its words: cut by the server from its own audio (`item.audio`), else played
    /// from this phone's recording (`conversation`). Neither when it can't be heard here.
    struct Clip: Equatable {
        /// The server's clip: its words, its audio, its turn.
        let item: ServerClient.NamingItem.Clip
        let conversation: CachedConversation?
        /// When it was said.
        let range: Range<CaptureInstant>?
        /// Where it was said, when known.
        let place: String?

        var isPlayable: Bool { range != nil && (item.audio != nil || conversation != nil) }
        /// What the player names it by.
        var playbackID: UUID? { item.audio?.jobId ?? conversation?.id }
    }

    /// A voice to name, with what this phone knows of it.
    struct Voice: Identifiable, Equatable {
        let item: ServerClient.NamingItem
        let clips: [Clip]
        /// The newest of its conversations here.
        let lastSeen: CaptureInstant?
        var id: String { item.id }
    }

    private(set) var voices: [Voice] = []
    /// The owner's people, for the answers.
    private(set) var people: [CachedPerson] = []
    /// A list was shown, kept or fresh, or the server couldn't be asked: "all caught up" can be trusted.
    private(set) var loaded = false
    /// A failed answer, for the owner to read; the voice is back in the list.
    var actionError: String?

    /// The voices to name, not counting the names to check again.
    var count: Int { voices.count { $0.item.kind != .recheck } }

    @ObservationIgnored private let library: LibraryStore?
    @ObservationIgnored private let sync: SyncStore?
    @ObservationIgnored private let client: ServerClient?

    private static let cache = URL.cachesDirectory.appending(path: "naming-queue.json")
    /// The server's job audio, one file per job, kept until iOS clears the caches.
    nonisolated static let clips = URL.cachesDirectory.appending(path: "clips", directoryHint: .isDirectory)

    init(library: LibraryStore?, sync: SyncStore?, client: ServerClient? = .production) {
        self.library = library
        self.sync = sync
        #if DEBUG
            self.client = FixtureLibrary.isRequested ? nil : client
        #else
            self.client = client
        #endif
    }

    /// The list as last kept, then the server's. Offline or failed, the list stays as it is.
    func refresh() async {
        #if DEBUG
            if FixtureLibrary.isRequested, let library {
                if !loaded { await show(await Self.fixture(in: library)) }
                return
            }
        #endif
        if !loaded, let data = try? Data(contentsOf: Self.cache),
            let kept = try? LibraryStore.feedDecoder.decode([ServerClient.NamingItem].self, from: data)
        {
            await show(kept)
        }
        guard var fresh = try? await client?.namingQueue() else {
            loaded = true
            return
        }
        fresh += (try? await client?.rechecks()) ?? []
        await show(fresh)
        try? ServerClient.encode(fresh).write(to: Self.cache, options: .atomic)
    }

    private func show(_ fresh: [ServerClient.NamingItem]) async {
        let answered = sync?.pending.namedVoices ?? []
        let items = fresh.filter { item in
            !item.voices.contains { answered.contains("\($0.jobId.uuidString.lowercased())|\($0.speakerLabel)") }
        }
        people = (try? await library?.people()) ?? people
        var voices: [Voice] = []
        for item in items {
            voices.append(await place(item))
        }
        self.voices = voices
        loaded = true
    }

    /// The item's clips: the server's audio when it has it, else this phone's audio of the server's conversation (the
    /// live one, when it was merged away).
    private func place(_ item: ServerClient.NamingItem) async -> Voice {
        var clips: [Clip] = []
        var lastSeen: CaptureInstant?
        for clip in item.clips {
            let conversation = try? await library?.conversation(clip.conversationId)
            var range: Range<CaptureInstant>?
            if let at = clip.at, let until = clip.until, at < until {
                range = CaptureInstant(at)..<CaptureInstant(until)
            }
            if let start = conversation?.range.lowerBound, start > lastSeen ?? start.advanced(by: -1) {
                lastSeen = start
            }
            clips.append(Clip(item: clip, conversation: conversation, range: range, place: conversation?.place))
        }
        return Voice(item: item, clips: clips, lastSeen: lastSeen)
    }

    /// Fetches the server's clips and rebuilds the evicted audio of the phone's ahead, so they play at once.
    func prepare(_ voice: Voice) async {
        for clip in voice.clips {
            if let audio = clip.item.audio {
                _ = await file(audio.jobId)
            } else if let range = clip.range, clip.conversation?.isImported != true {
                try? await sync?.restorePlayback(covering: range)
            }
        }
    }

    /// A job's audio on the phone, fetched first when it isn't yet; `nil` when the fetch fails.
    func file(_ job: UUID) async -> URL? {
        let file = Self.clips.appending(path: "\(job.uuidString.lowercased()).ogg")
        if FileManager.default.fileExists(atPath: file.path) { return file }
        guard let data = try? await client?.jobAudio(job) else { return nil }
        try? FileManager.default.createDirectory(at: Self.clips, withIntermediateDirectories: true)
        return (try? data.write(to: file, options: .atomic)) == nil ? nil : file
    }

    // MARK: Answers

    /// The owner's answer for `voice`: it leaves the list and goes to the outbox now. A name goes as typed; the server
    /// finds the person it is, other names included.
    func answer(_ voice: Voice, with answer: ServerClient.NamingAnswer) {
        let index = voices.firstIndex { $0.id == voice.id } ?? voices.count
        voices.removeAll { $0.id == voice.id }
        Task {
            if let error = await sync?.perform(.naming(item: voice.item, answer: answer)) {
                voices.insert(voice, at: min(index, voices.count))
                actionError = error
            } else if case .several = answer {
                // Its conversations are summarized again, as the owner's Generate (owner, Oct 15).
                for id in Set(voice.item.voices.map(\.conversationId)) {
                    let conversation = try? await library?.conversation(id)
                    _ = await sync?.perform(
                        .summarize(conversation: conversation?.id ?? id, after: conversation?.runId))
                }
            }
        }
    }

    /// One passage of a voice of several people, named in place: its turn alone, as the owner's.
    func name(_ clip: Clip, as target: ServerClient.SpeakerTarget) {
        guard let job = clip.item.jobId, let label = clip.item.speakerLabel, let turn = clip.item.turnIndex else {
            return
        }
        Task {
            if let error = await sync?.perform(.speaker(job: job, label: label, target: target, turnIndex: turn)) {
                actionError = error
            }
        }
    }

    /// Asked about again after the others.
    func skip(_ voice: Voice) {
        guard let index = voices.firstIndex(where: { $0.id == voice.id }) else { return }
        voices.append(voices.remove(at: index))
    }
}

#if DEBUG
    extension NamingQueue {
        /// The demo library's voices to name (`-fixtureLibrary`): one that sounds like one of its people, one the
        /// summaries heard a name for, one nobody named; their clips sit in its newest conversations.
        static func fixture(in library: LibraryStore) async -> [ServerClient.NamingItem] {
            let records = (try? await library.conversations(before: nil, limit: 4)) ?? []
            let person = try? await library.people().first { !$0.isOwner }
            let me = try? await library.people().first(where: \.isOwner)
            let words = [
                "Les classificateurs, c'est la partie qui coûte le plus, mais c'est aussi celle qui marche.",
                "On se retrouve au marché samedi, vers dix heures ? Il y aura les fraises.",
                "Je te l'avais dit, la maison d'à côté est vendue depuis le printemps.",
            ]
            let iso = ISO8601DateFormatter()
            let json: [[String: Any]] = records.enumerated().map { index, record in
                let start = record.startAt
                let server = record.id.uuidString.lowercased()
                let clips = (0..<2).map { k in
                    let text = words[(index + k) % words.count]
                    // Spoken evenly over its 8 s.
                    let pieces = text.split(separator: " ").enumerated().map { $0 == 0 ? $1 : " " + $1 }
                    let step = 8000 / pieces.count
                    return [
                        "at": iso.string(from: start.addingTimeInterval(Double(2 + k * 12))),
                        "until": iso.string(from: start.addingTimeInterval(Double(10 + k * 12))),
                        "conversationId": server, "text": text, "jobId": UUID().uuidString.lowercased(),
                        "speakerLabel": "speaker_1", "turnIndex": k,
                        // The first reads as the owner's own: "several people" opens with it named.
                        "personId": (k == 0 ? me?.id.uuidString.lowercased() : nil).map { $0 as Any } ?? NSNull(),
                        "words": pieces.indices.map { [$0 * step, $0 * step + step - 50, pieces[$0].utf16.count] },
                    ] as [String: Any]
                }
                let known = index == 0 ? person : index == 3 ? me : nil
                return [
                    "id": "fixture-\(index)",
                    "kind": index == 3
                        ? "recheck" : index == 2 ? "several" : known == nil ? "new_person" : "known_person",
                    "name": index == 1 ? "Hervé" : NSNull(),
                    "personId": known.map { $0.id.uuidString.lowercased() } ?? NSNull(),
                    // The last one he named, and it sounds like him.
                    "namedPersonId": (index == 3 ? person?.id.uuidString.lowercased() : nil).map { $0 as Any }
                        ?? NSNull(),
                    "conversations": 1 + index, "seconds": 240 + index * 300, "exchanges": 40 - index * 10,
                    "evidence": index == 1
                        ? [
                            [
                                "at": iso.string(from: start), "conversationId": server,
                                "text": "Merci Hervé, à samedi alors.",
                            ]
                        ]
                        : [],
                    "voices": [], "clips": clips,
                ]
            }
            guard let data = try? JSONSerialization.data(withJSONObject: json) else { return [] }
            return (try? LibraryStore.feedDecoder.decode([ServerClient.NamingItem].self, from: data)) ?? []
        }
    }
#endif
