#if DEBUG
    import AudioPipeline
    import Foundation
    import Library
    import Timeline
    import Upload

    /// A seeded cache with playable audio, so the whole app runs in the simulator without a Pendant or a server.
    /// Launch with `-fixtureLibrary`. It is rebuilt in a temporary directory at each launch, from a feed page as the
    /// server would send it; the driver stays off. `-fixtureDays 6` adds six earlier days of 30 conversations each
    /// (copies of the short scripts, without audio), for measuring the library list, refresh and search.
    enum FixtureLibrary {
        nonisolated static let isRequested = ProcessInfo.processInfo.arguments.contains("-fixtureLibrary")
        nonisolated static let extraDays = UserDefaults.standard.integer(forKey: "fixtureDays")
        nonisolated static let directory = URL.temporaryDirectory.appending(
            path: "lifelog-fixtures", directoryHint: .isDirectory)
        nonisolated static var audio: DerivedAudioDirectory {
            DerivedAudioDirectory(url: directory.appending(path: "derived", directoryHint: .isDirectory))
        }
        static let people = Dictionary(
            uniqueKeysWithValues: FixtureConversation.people.enumerated().map {
                ($0.element, ConversationID(anchor: CaptureInstant(millis: Int64($0.offset + 1))).serverID)
            })

        private static var seeding: Task<Void, Never>?
        /// What the uploader would say the server doesn't have yet.
        private(set) static var unsent: [Range<CaptureInstant>] = []
        private(set) static var uploads: UploadStatus?

        /// A fresh library, seeded in the background; `ready()` waits for the seeding.
        static func open() -> LibraryStore? {
            try? FileManager.default.removeItem(at: directory)
            do {
                let library = try LibraryStore(
                    directory: directory.appending(path: "library", directoryHint: .isDirectory))
                seeding = Task { await seed(library) }
                return library
            } catch {
                print("Fixture library failed: \(error)")
                return nil
            }
        }

        static func ready() async { await seeding?.value }

        static func layouts(now: Date = .now) -> [FixtureLayout] {
            (FixtureConversation.all + FixtureConversation.days(extraDays)).map {
                FixtureLayout($0, now: now, people: people)
            }
        }

        private static func seed(_ library: LibraryStore) async {
            do {
                let layouts = layouts()
                try await library.apply(feed: try page(layouts)) { _ in }
                let unsent = layouts.filter { $0.upload == .notUploaded }
                Self.unsent = unsent.map(\.conversation.range)
                uploads = UploadStatus(unsent: .milliseconds(unsent.reduce(0) { $0 + $1.conversation.range.millis }))
                try await writeAudio(
                    layouts.prefix(FixtureConversation.all.count).map { ($0.recorded, $0.words) },
                    deviceID: PlaybackStore.deviceID)
            } catch {
                print("Fixture library failed: \(error)")
            }
        }

        /// The fixtures as one feed page (contract "The feed").
        static func page(_ layouts: [FixtureLayout]) throws -> Data {
            /// JSON's `null` for `nil`.
            func some(_ value: Any?) -> Any { value ?? NSNull() }
            let iso = { (date: Date) in date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)) }
            let key = { (id: UUID) in id.uuidString.lowercased() }
            var conversations: [[String: Any]] = []
            var turns: [[String: Any]] = []
            var chapters: [[String: Any]] = []
            var edits: [[String: Any]] = []
            for layout in layouts {
                let conversation = layout.conversation
                conversations.append([
                    "id": key(conversation.id), "startAt": iso(conversation.startAt), "endAt": iso(conversation.endAt),
                    "kind": conversation.kind.rawValue, "title": some(conversation.title),
                    "ownerTitle": some(conversation.ownerTitle), "tldr": some(conversation.tldr),
                    "place": some(conversation.place), "retired": some(nil),
                    "state": layout.upload == .notUploaded
                        ? "uploaded"
                        : layout.upload == .done
                            ? (conversation.tldr == nil ? "transcribed" : "summarized") : "\(layout.upload)",
                    "waiting": some(
                        conversation.tldr == nil && !layout.turns.isEmpty
                            ? ["reason": "macAway", "since": iso(conversation.endAt)] : nil),
                    "splitSuggestions": (conversation.splitSuggestions ?? []).map {
                        ["at": iso($0.at), "confidence": "medium"]
                    },
                    "startEdit": some(conversation.startEdit.map(key)),
                ])
                for turn in layout.turns {
                    turns.append([
                        "jobId": key(turn.jobId), "turnIndex": turn.turnIndex, "conversationId": key(conversation.id),
                        "startAt": iso(turn.startAt), "endAt": iso(turn.endAt), "text": turn.text,
                        "language": some(turn.language),
                        "speaker": [
                            "label": some(turn.speaker.label), "personId": some(turn.speaker.personId.map(key)),
                            "personName": some(turn.speaker.personName), "isOwner": turn.speaker.isOwner ?? false,
                            "displayName": turn.speaker.displayName,
                        ],
                        "words": turn.words ?? [],
                    ])
                }
                for chapter in layout.chapters {
                    chapters.append([
                        "id": key(chapter.id), "conversationId": key(conversation.id), "startAt": iso(chapter.startAt),
                        "endAt": iso(chapter.endAt), "title": some(chapter.title), "summary": some(nil),
                        "kind": "conversation",
                    ])
                }
                if conversation.startEdit != nil {
                    edits.append([
                        "id": key(layout.job), "kind": "split", "at": iso(conversation.startAt), "source": "ai",
                        "editedAt": iso(conversation.startAt), "undoneAt": some(nil),
                    ])
                }
            }
            let people = Self.people.map { name, id in
                ["id": key(id), "name": name, "isOwner": name == "Dave", "aliases": []] as [String: Any]
            }
            let page: [String: Any] = [
                "cursor": "1", "more": false, "conversations": conversations, "turns": turns, "chapters": chapters,
                "people": people, "edits": edits,
                "switches": ["transcription": true, "ai": true, "engine": "claude", "openAppAfterMinutes": 15],
                "mac": ["dictatingSince": some(nil), "llm": ["able": false, "reason": some(nil)]],
                "vocabulary": ["Nok", "Izipizi", "Théo", "Oakridge"],
            ]
            return try JSONSerialization.data(withJSONObject: page)
        }

        /// Speech-like audio: a buzzing voice per speaker exactly where each word is, silence between. Files are cut
        /// at 10 minutes like the real ones.
        @concurrent
        private static func writeAudio(
            _ conversations: [([Range<CaptureInstant>], [(range: Range<CaptureInstant>, speaker: Int)])],
            deviceID: String
        )
            async throws
        {
            var page: UInt64 = 0
            var voice = Voice()
            let maxMillis = PlaybackSegment.maxMillis
            for (recorded, words) in conversations {
                for stretch in recorded {
                    var start = stretch.lowerBound
                    while start < stretch.upperBound {
                        let millis = min(maxMillis, start.distance(to: stretch.upperBound))
                        let pages = page...(page + UInt64(millis / 1000))
                        page = pages.upperBound + 1
                        let origin = start
                        let inside = words.filter { $0.range.overlaps(origin..<origin.advanced(by: millis)) }
                        try audio.writePlayback(deviceID: deviceID, pages: pages, start: origin, millis: millis) {
                            voice.samples($0, words: inside, from: origin)
                        }
                        start = start.advanced(by: millis)
                    }
                }
            }
        }

        /// Copies a cached waveform per (speaker, word length) into place, so a debug build synthesizes half an hour
        /// in a moment.
        nonisolated private struct Voice {
            private var waves: [Int: [Float]] = [:]

            /// `range` counts 16 kHz samples from `origin`.
            mutating func samples(
                _ range: Range<Int>, words: [(range: Range<CaptureInstant>, speaker: Int)], from origin: CaptureInstant
            ) -> [Float] {
                var samples = [Float](repeating: 0, count: range.count)
                let first = Int(origin.millis) * 16 + range.lowerBound
                for word in words {
                    let start = Int(word.range.lowerBound.millis) * 16
                    let end = Int(word.range.upperBound.millis) * 16
                    let (low, high) = (max(start, first), min(end, first + range.count))
                    guard low < high else { continue }
                    let wave = wave(pitch: word.speaker, length: end - start)
                    samples.replaceSubrange(low - first..<high - first, with: wave[low - start..<high - start])
                }
                return samples
            }

            /// A sawtooth with 30 ms fades; pitch by speaker number.
            private mutating func wave(pitch speaker: Int, length: Int) -> [Float] {
                let key = speaker * 1_000_000 + length
                if let wave = waves[key] { return wave }
                let hertz = Float([115, 210, 160][speaker % 3])
                let wave = (0..<length).map { index in
                    let phase = (Float(index) * hertz / 16_000).truncatingRemainder(dividingBy: 1)
                    return (2 * phase - 1) * 0.18 * min(Float(min(index, length - index)) / 480, 1)
                }
                waves[key] = wave
                return wave
            }
        }
    }
#endif
