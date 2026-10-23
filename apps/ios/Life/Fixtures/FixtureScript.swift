#if DEBUG
    import Foundation
    import Library
    import Timeline

    /// Six realistic conversations over yesterday and today and a long one two days ago, in English, French and Thai,
    /// and two wordless clips, for the fixture library and previews, as the feed would send them. Each script line is
    /// one turn; it repeats until the conversation's length is filled. Words get plain timings (longer words take
    /// longer), and the synthesized audio voices exactly those timings.
    struct FixtureConversation {
        struct Turn {
            var label: String
            /// Words split on spaces; "|" joins Thai syllables with no space, as the provider spaces Thai.
            var text: String
        }

        var startMinutesAgo: Int
        var minutes: Double
        var ownerTitle: String?
        /// The TLDR as the server renders it: the owner as "you", others by name.
        var generated: (title: String, tldr: String, chapters: [(minute: Double, title: String)])?
        var place: String?
        var upload: Upload
        var language: String?
        var turns: [Turn]
        /// Provider label to person name; the owner is "Dave". Unlisted labels are unnamed voices.
        var speakers: [String: String]
        /// Seconds from the start the Pendant did not record (no audio file covers them).
        var unrecorded: Range<Int64>?
        /// The summary run split this one off by itself ("Split by AI · Undo").
        var automaticSplit = false
        /// `silent` for a wordless clip, `dictation` for the owner dictating to the Mac: the library folds both into
        /// a line a day.
        var kind = ConversationKind.conversation
        /// Minutes from the start where the summary run suggests a split ("Split here?").
        var splitSuggestion: Double?

        /// Where its audio stands with the server.
        enum Upload {
            case done, notUploaded, uploaded, transcribing
        }

        static let people = ["Dave", "Mai", "Claire", "Somchai"]
    }

    extension FixtureConversation {
        static let all: [FixtureConversation] = [
            FixtureConversation(
                startMinutesAgo: 27 * 60, minutes: 11, ownerTitle: nil,
                generated: (
                    "Coffee with Mai",
                    "You and Mai planned Saturday's market trip, you practised asking prices in Thai, and Mai recommended a khao soi place near the BTS.",
                    [(0, "Weekend plans"), (4, "Thai lessons"), (8, "Where to eat")]
                ), place: "Oakridge 21", upload: .done, language: "en",
                turns: [
                    .init(label: "speaker_0", text: "Morning Mai, did you sleep well?"),
                    .init(label: "speaker_1", text: "Yes, pretty good. สบาย|ดี|ค่ะ"),
                    .init(label: "speaker_0", text: "Great. Are we still going to the market on Saturday?"),
                    .init(label: "speaker_1", text: "ใช่|ค่ะ we can go early, around eight, before it gets too hot."),
                    .init(label: "speaker_0", text: "Perfect. Can you teach me how to ask for the price?"),
                    .init(label: "speaker_1", text: "Sure, you say เท่า|ไหร่|ครับ when you are a man. Easy."),
                    .init(label: "speaker_0", text: "เท่า|ไหร่|ครับ okay, I think I got it."),
                    .init(
                        label: "speaker_1", text: "There is a small restaurant near the BTS, the khao soi is amazing."),
                    .init(label: "speaker_0", text: "Let's try it after the market then."),
                ],
                speakers: ["speaker_0": "Dave", "speaker_1": "Mai"], unrecorded: 360..<363, splitSuggestion: 8),
            FixtureConversation(
                startMinutesAgo: 25 * 60, minutes: 4, ownerTitle: nil,
                generated: (
                    "Réunion produit",
                    "Claire valide la feuille de route ; la synchronisation du Pendant reste prioritaire et un ticket sera ouvert pour les pages en double.",
                    [(0, "Feuille de route"), (2, "Bugs de synchronisation")]
                ), place: "WeWork T-One", upload: .done, language: "fr",
                turns: [
                    .init(
                        label: "speaker_1",
                        text: "Bon, on commence ? L'idée c'est de valider la feuille de route du trimestre."),
                    .init(label: "speaker_0", text: "Oui. Pour moi la priorité reste la synchronisation du Pendant."),
                    .init(
                        label: "speaker_2",
                        text: "Je suis d'accord, on a encore des pages en double après une reconnexion."),
                    .init(label: "speaker_1", text: "Tu peux ouvrir un ticket avec les journaux ?"),
                    .init(label: "speaker_2", text: "Oui, je le fais cet après-midi."),
                    .init(label: "speaker_0", text: "Et on garde la sortie de la version deux pour fin octobre."),
                ],
                speakers: ["speaker_0": "Dave", "speaker_1": "Claire"], automaticSplit: true),
            FixtureConversation(
                startMinutesAgo: 20 * 60, minutes: 3, ownerTitle: nil, generated: nil, place: "Riverside",
                upload: .done, language: "th",
                turns: [
                    .init(label: "speaker_0", text: "พี่|ครับ อัน|นี้|เท่า|ไหร่|ครับ"),
                    .init(label: "speaker_1", text: "สาม|ร้อย|บาท|ค่ะ"),
                    .init(label: "speaker_0", text: "ลด|ได้|ไหม|ครับ"),
                    .init(label: "speaker_1", text: "สอง|ร้อย|ห้า|สิบ ได้|ค่ะ"),
                    .init(label: "speaker_0", text: "โอเค เอา|สอง|อัน|ครับ"),
                ],
                speakers: [:]),
            FixtureConversation(
                startMinutesAgo: 6 * 60, minutes: 2, ownerTitle: nil, generated: nil, place: nil,
                upload: .notUploaded, language: nil, turns: [], speakers: [:]),
            FixtureConversation(
                startMinutesAgo: 4 * 60, minutes: 1.5, ownerTitle: nil, generated: nil, place: "Oakridge 21",
                upload: .uploaded, language: nil, turns: [], speakers: [:]),
            FixtureConversation(
                startMinutesAgo: 3 * 60, minutes: 2.5, ownerTitle: nil, generated: nil, place: "Oakridge 21",
                upload: .transcribing, language: nil, turns: [], speakers: [:]),
            FixtureConversation(
                startMinutesAgo: 70, minutes: 5, ownerTitle: "Condo call with Somchai",
                generated: (
                    "Bathroom renovation quote",
                    "Somchai quoted 45,000 baht to replace the old bathroom pipes, tiles included, starting Monday if you confirmed by Friday.",
                    [(0, "The pipes"), (2.5, "Price and start date")]
                ), place: "Oakridge 21", upload: .done, language: "en",
                turns: [
                    .init(label: "speaker_0", text: "Hi Somchai, thanks for calling back."),
                    .init(label: "speaker_1", text: "No problem khun Dave. I checked the bathroom yesterday."),
                    .init(label: "speaker_0", text: "And? How bad is it?"),
                    .init(
                        label: "speaker_1",
                        text: "The pipes are old, we need to change everything. About forty-five thousand baht."),
                    .init(label: "speaker_0", text: "Okay. C'est plus que prévu, mais bon."),
                    .init(label: "speaker_1", text: "Dave, ask him if the price includes the tiles."),
                    .init(label: "speaker_0", text: "Does the price include the tiles? When can you start?"),
                    .init(label: "speaker_1", text: "Tiles included. Next Monday if you confirm by Friday."),
                ],
                speakers: ["speaker_0": "Dave", "speaker_1": "Somchai"]),
            // A long day like the one the lag was found on: 2 h 54, 39 voices, about 1,650 turns, and its summary
            // failed.
            FixtureConversation(
                startMinutesAgo: 48 * 60, minutes: 174, ownerTitle: nil, generated: nil, place: "WeWork T-One",
                upload: .done, language: "en",
                turns: (0..<39).map {
                    .init(label: "speaker_\($0)", text: "So where are we on the launch plan for next week?")
                },
                speakers: ["speaker_0": "Dave", "speaker_1": "Claire"]),
            // Two clips a speech detector guessed at, transcribed without a word: the server calls them silent.
            FixtureConversation(
                startMinutesAgo: 5 * 60, minutes: 0.03, ownerTitle: nil, generated: nil, place: nil, upload: .done,
                language: nil, turns: [], speakers: [:], kind: .silent),
            FixtureConversation(
                startMinutesAgo: 5 * 60 - 3, minutes: 0.02, ownerTitle: nil, generated: nil, place: nil, upload: .done,
                language: nil, turns: [], speakers: [:], kind: .silent),
            // The owner dictating to the Mac: never transcribed.
            FixtureConversation(
                startMinutesAgo: 2 * 60, minutes: 1.5, ownerTitle: nil, generated: nil, place: "Oakridge 21",
                upload: .done, language: nil, turns: [], speakers: [:], kind: .dictation),
        ]
    }

    extension FixtureConversation {
        /// `count` days before the fixtures, 30 conversations a day, 40 minutes apart: the short scripts in turn.
        static func days(_ count: Int) -> [FixtureConversation] {
            let short = all.filter { $0.minutes < 60 }
            return (0..<count * 30).map { index in
                var copy = short[index % short.count]
                copy.startMinutesAgo = (3 + index / 30) * 24 * 60 + index % 30 * 40
                return copy
            }
        }
    }

    /// One fixture conversation laid out in capture time, as the feed's rows.
    struct FixtureLayout {
        var conversation: CachedConversation
        var turns: [CachedTurn]
        var chapters: [CachedChapter]
        /// Every word with its speaker, for the synthesized audio.
        var words: [(range: Range<CaptureInstant>, speaker: Int)]
        /// Stretches with audio files.
        var recorded: [Range<CaptureInstant>]
        var upload: FixtureConversation.Upload
        /// The job its turns came from; also the id of its automatic split, when it has one.
        var job: UUID

        init(_ script: FixtureConversation, now: Date, people: [String: UUID]) {
            let nowMillis = Int64(now.timeIntervalSince1970 / 60) * 60_000
            let start = CaptureInstant(millis: nowMillis - Int64(script.startMinutesAgo) * 60_000)
            let length = Int64(script.minutes * 60_000)
            let range = start..<start.advanced(by: length)
            let id = ConversationID(anchor: start).serverID
            job = ConversationID(anchor: start.advanced(by: 1)).serverID
            let name = { (label: String) in script.speakers[label] }
            conversation = CachedConversation(
                id: id, startAt: range.lowerBound.date, endAt: range.upperBound.date, kind: script.kind,
                title: script.generated?.title, ownerTitle: script.ownerTitle, tldr: script.generated?.tldr,
                place: script.place,
                splitSuggestions: script.splitSuggestion.map {
                    [.init(at: start.advanced(by: Int64($0 * 60_000)).date)]
                },
                startEdit: script.automaticSplit ? job : nil)
            chapters =
                script.generated?.chapters.map {
                    let at = start.advanced(by: Int64($0.minute * 60_000))
                    return CachedChapter(
                        id: ConversationID(anchor: at).serverID, startAt: at.date, endAt: range.upperBound.date,
                        title: $0.title)
                } ?? []
            upload = script.upload

            let gap = script.unrecorded.map {
                start.advanced(by: $0.lowerBound * 1000)..<start.advanced(by: $0.upperBound * 1000)
            }
            recorded = gap.map { [start..<$0.lowerBound, $0.upperBound..<range.upperBound] } ?? [range]

            // Words, repeating the script until the conversation is full; none inside the unrecorded stretch.
            var words: [(range: Range<CaptureInstant>, speaker: Int)] = []
            var turns: [CachedTurn] = []
            var cursor: Int64 = 1_000
            var turnIndex = 0
            // As the server names voices: a person (the owner too), else "Speaker N" by first words.
            var unnamed: [String: String] = [:]
            while !script.turns.isEmpty, cursor < length - 5_000 {
                let turn = script.turns[turnIndex % script.turns.count]
                var first: CaptureInstant?
                var text = ""
                var timed: [[Int64]] = []
                for (offset, token) in turn.text.split(separator: " ").enumerated() {
                    for (part, syllable) in token.split(separator: "|").enumerated() {
                        let millis = Int64(180 + 60 * min(syllable.count, 12))
                        var at = start.advanced(by: cursor)
                        if let gap, gap.contains(at) || gap.contains(at.advanced(by: millis)) {
                            cursor = gap.upperBound.millis - start.millis + 300
                            at = start.advanced(by: cursor)
                        }
                        first = first ?? at
                        let piece = (part > 0 || offset == 0 ? "" : " ") + syllable
                        let from = first?.distance(to: at) ?? 0
                        timed.append([from, from + millis, Int64(piece.utf16.count)])
                        text += piece
                        words.append((at..<at.advanced(by: millis), Int(turn.label.dropFirst(8)) ?? 9))
                        cursor += millis + 120
                    }
                }
                let person = name(turn.label)
                if person == nil, unnamed[turn.label] == nil { unnamed[turn.label] = "Speaker \(unnamed.count + 1)" }
                turns.append(
                    CachedTurn(
                        jobId: job, turnIndex: turnIndex, startAt: (first ?? start).date,
                        endAt: start.advanced(by: cursor).date, text: text, language: script.language,
                        speaker: .init(
                            label: turn.label, displayName: person ?? unnamed[turn.label] ?? "",
                            personId: person.flatMap { people[$0] }, personName: person, isOwner: person == "Dave"
                        ), words: timed))
                cursor += 700
                turnIndex += 1
            }
            self.words = words
            self.turns = turns
        }
    }
#endif
