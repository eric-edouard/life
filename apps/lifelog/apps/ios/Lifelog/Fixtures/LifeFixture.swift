#if DEBUG
    import Foundation
    import Library
    import LifeConnector
    import Synchronization
    import Upload

    /// Life without a Mac, for the simulator: made-up inbox, matters and agents, and an API that answers as Life would,
    /// slowly, or not at all, so every state of every screen can be put on screen and photographed.
    ///
    /// `-fixtureLife <scenario>` turns it on: `ok`, `many` (261 asks, for measuring the swipe), `groups` (three that block, then all that can wait), `loading`, `empty`, `improves` (only what can wait), `stale`, `slowPush` (a tapped push's one-card read takes 5 s), `slowInbox` (every whole read after the first takes 30 s), `unreachable`, `failed`, `notPaired`.
    /// `-fixtureAnswer sent|sending|notSent|wroteSince|mayHaveGone` decides what a tap on a draft does (`failed`: any other answer is refused); `-fixtureStart started|starting|failed`
    /// what "Start" does. `-fixtureCard <ref>`, `-fixtureTab matters|search`, `-fixtureMatter <id>`, and `-fixtureSheet pendant|settings|agent|pair|pairing|replacePendant|pairPendant`
    /// open the screen to show. `-fixturePose wide|upright` draws the iPhone Duo open (`DuoPose`).
    enum LifeFixture {
        nonisolated static let scenario = value(of: "-fixtureLife")
        nonisolated static var isRequested: Bool { scenario != nil }
        nonisolated static let answer = value(of: "-fixtureAnswer") ?? "sent"
        nonisolated static let start = value(of: "-fixtureStart") ?? "started"
        nonisolated static let card = value(of: "-fixtureCard")
        /// `-fixtureOnly <ref>`: the inbox holds that one card, for a screenshot of a card that is not the first.
        nonisolated static let tab = value(of: "-fixtureTab")
        nonisolated static let matter = value(of: "-fixtureMatter")
        nonisolated static let sheet = value(of: "-fixtureSheet")
        /// What approving a pairing does: `ok` (after a moment), `slow` (never ends), `expired` (the code is refused).
        /// `-fixturePage life|server|diagnostics`: Settings opens that page.
        nonisolated static let page = value(of: "-fixturePage")
        nonisolated static let pair = value(of: "-fixturePair") ?? "ok"
        nonisolated static let pose = value(of: "-fixturePose")
        /// `-fixtureUpload settled|behind`: what the phone says is on the Mac, so the Pendant sheet's upload tile
        /// shows "All on your Mac" or what is still to send (no flag: the phone is still being asked).
        nonisolated static var uploads: UploadStatus? {
            let now = Date.now
            return switch value(of: "-fixtureUpload") {
            case "settled": UploadStatus(sentThrough: now, heardThrough: now)
            case "behind": UploadStatus(unsent: .seconds(2_520), sentThrough: now - 3_600, heardThrough: now)
            default: nil
            }
        }

        nonisolated private static func value(of flag: String) -> String? {
            let arguments = ProcessInfo.processInfo.arguments
            return arguments.firstIndex(of: flag).flatMap {
                arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil
            }
        }

        @MainActor static func store() -> LifeStore {
            let scenario = scenario ?? "ok"
            let directory = URL.temporaryDirectory.appending(path: "life-fixture-reads", directoryHint: .isDirectory)
            let cache = ReadCache(directory: directory)
            cache.clear()
            let api = FixtureAPI(scenario: scenario)
            if scenario == "stale" {
                cache.store(api.inbox(), key: "read_inbox")
                cache.store(api.matters(), key: "read_matters")
                cache.store(api.agents(), key: "read_registered_agents")
            }
            return LifeStore(
                tokens: FixtureTokens(isPaired: scenario != "notPaired"), api: api,
                approve: { _ in try await approve() },
                cache: cache, setBadge: { _ in })
        }
    }

    /// A pairing's approval, as `-fixturePair` says it goes.
    nonisolated private func approve() async throws -> LifeCredentials {
        switch LifeFixture.pair {
        case "slow": try await Task.sleep(for: .seconds(3_600))
        case "expired": try await Task.sleep(for: .seconds(1)); throw MCPError.wrongCode
        default: try await Task.sleep(for: .seconds(1))
        }
        guard let origin = URL(string: "https://life.example.test") else { throw MCPError.wrongCode }
        return LifeCredentials(
            endpoint: LifeEndpoint(
                origin: origin, clientID: "fixture", tokenEndpoint: origin, resource: origin.absoluteString),
            tokens: LifeTokens(access: "fixture", refresh: "fixture", expiresAt: .distantFuture))
    }

    nonisolated private struct FixtureTokens: TokenStore {
        let isPaired: Bool
        func load() -> LifeCredentials? {
            guard isPaired, let origin = URL(string: "https://life.example.test") else { return nil }
            return LifeCredentials(
                endpoint: LifeEndpoint(
                    origin: origin, clientID: "fixture", tokenEndpoint: origin, resource: origin.absoluteString),
                tokens: LifeTokens(access: "fixture", refresh: "fixture", expiresAt: .distantFuture))
        }
        func save(_ credentials: LifeCredentials) {}
        func clear() {}
    }

    /// Instants of the made-up week, in the phone's own zone so "Thu 18:00" reads the same wherever it runs.
    nonisolated private func at(_ day: Int, _ hour: Int, _ minute: Int = 0, month: Int = 11) -> String {
        let parts = DateComponents(year: 2026, month: month, day: day, hour: hour, minute: minute)
        let date = Calendar.current.date(from: parts) ?? .distantPast
        return date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    nonisolated private final class FixtureAPI: LifeAPI, Sendable {
        let scenario: String
        private let answered = Mutex(Set<String>())
        private let started = Mutex(false)
        private let wholeReads = Mutex(0)

        init(scenario: String) {
            self.scenario = scenario
            Self.seedClipAudio()
        }

        private func gate() async throws {
            switch scenario {
            case "loading": try await Task.sleep(for: .seconds(3_600))
            case "unreachable", "stale": throw MCPError.unreachable
            case "failed": throw MCPError.failed("Life answered 502 from its proxy.")
            case "notPaired": throw MCPError.notPaired
            default: break
            }
        }

        private func json(_ value: Any) -> String {
            String(
                decoding: (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data(),
                as: UTF8.self)
        }

        // MARK: Reads

        func readInbox() async throws -> String {
            try await gate()
            if scenario == "slowInbox",
                wholeReads.withLock({
                    $0 += 1; return $0
                }) > 1
            {
                try await Task.sleep(for: .seconds(30))
            }
            return inbox()
        }
        func readInbox(pushId: String) async throws -> String {
            try await gate()
            if scenario == "slowPush" { try await Task.sleep(for: .seconds(5)) }
            // A push's read: just that card, none once answered.
            var one = (try? JSONSerialization.jsonObject(with: Data(inbox().utf8))) as? [String: Any] ?? [:]
            one["checks"] = (one["checks"] as? [[String: Any]] ?? []).filter { $0["pushId"] as? String == pushId }
            return json(one)
        }
        func readMatters() async throws -> String { try await gate(); return matters() }
        func readRegisteredAgents() async throws -> String { try await gate(); return agents() }

        func readMatter(_ id: String) async throws -> String {
            try await gate()
            guard let row = Self.rows.first(where: { $0["id"] as? String == id }) else {
                throw MCPError.failed("No such matter.")
            }
            var matter = row
            let hasAgent = id == "matter_lease" || (id == "matter_table" && started.withLock { $0 })
            let index = ["matter_lease": 0, "matter_kitchen": 1, "matter_table": 2, "matter_nora": 3][id]
            matter["agents"] =
                (hasAgent || id == "matter_kitchen" || id == "matter_nora") ? [Self.agent(index ?? 2)] : []
            if id == "matter_table", started.withLock({ $0 }) { matter["agent"] = "agt_table" }
            matter["steps"] = Self.steps(id)
            // Every open check about it, of every kind, as `read_matter` sends them.
            let left = answered.withLock { $0 }
            matter["checks"] = Self.checks.filter {
                ($0["matter"] as? [String: Any])?["id"] as? String == id && !left.contains($0["ref"] as? String ?? "")
            }
            // Nora's page stays short, so the agent's row shows above the fold.
            if id == "matter_nora" { matter["checks"] = Array((matter["checks"] as? [[String: Any]] ?? []).prefix(1)) }
            return json(matter)
        }

        /// Every open ask, what blocks first, as `read_inbox` sends it; `improves` holds only what can wait (the list's
        /// "The rest can wait" first), `empty` nothing.
        func inbox() -> String {
            let left = answered.withLock { $0 }
            var open = Self.checks.filter { !left.contains($0["ref"] as? String ?? "") }
                .filter { scenario != "improves" || $0["urgency"] as? String == "improves" }
            // `groups`: a few that block, so the list shows "The rest can wait" and what only improves, in a screen.
            if scenario == "groups" {
                var blocking = 0
                open = open.filter { check in
                    if check["urgency"] as? String == "improves" { return true }
                    blocking += 1
                    return blocking < 4
                }
            }
            // `many`: the same asks again under new refs, 261 in all.
            var shown = open
            if scenario == "many" {
                shown = (0..<261).map { n in
                    var check = open[n % open.count]
                    check["ref"] = "\(check["ref"] as? String ?? "")-\(n)"
                    check["pushId"] = "push-\(n)"
                    return check
                }
            }
            let checks = (scenario == "empty" ? [] : shown).map { check in
                // A guess already answered is no longer asked beside its draft.
                var check = check
                check["confirm"] = (check["confirm"] as? [[String: Any]] ?? []).filter {
                    !left.contains($0["ref"] as? String ?? "")
                }
                return check
            }
            let blocking = checks.count { $0["urgency"] as? String == "blocks" }
            return json([
                "checks": checks,
                "counts": Dictionary(grouping: checks, by: { $0["group"] as? String ?? "" }).mapValues(\.count),
                "total": checks.count, "blocking": blocking, "deadlinesToday": 1,
            ])
        }

        func matters() -> String {
            json(["matters": Self.rows.map { row in row.filter { $0.key != "agents" && $0.key != "steps" } }])
        }

        func agents() -> String {
            json(["agents": [Self.agent(0), Self.agent(1)], "desk": "ok", "helper": "running", "refused": []])
        }

        // MARK: Actions

        private func message(_ object: [String: Any]) -> Data {
            (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        }

        /// The `-fixtureAnswer` values where a send ends without going.
        private static let refused: Set = ["notSent", "wroteSince", "mayHaveGone"]

        func answerCheck(_ answer: AnswerRequest, answerKey: String, onProgress: @escaping @Sendable (Data) -> Void)
            async throws -> String
        {
            try await gate()
            let check = Self.checks.first { $0["ref"] as? String == answer.ref }
            let draft = check?["draft"] as? [String: Any]
            let isNewMatter = check?["group"] as? String == "new matter"
            let plan =
                isNewMatter
                ? (answer.options == ["start"]
                    ? ["goal_saved", "desk_accepted", "session_open", "turn_begun"]
                    : answer.options == ["edit-goal"] ? ["goal_saved"] : ["recorded"])
                : draft == nil ? ["recorded"] : ["recorded", "chat_checked", "handed", "confirmed"]
            onProgress(message(["plan": plan, "limitSeconds": 20]))
            for step in plan {
                try await Task.sleep(for: .milliseconds(700))
                if isNewMatter, step == "desk_accepted", LifeFixture.start == "starting" {
                    try await Task.sleep(for: .seconds(3_600))
                }
                if isNewMatter, step == "desk_accepted", LifeFixture.start == "failed" {
                    return json([
                        "ref": answer.ref, "kind": "new matter",
                        "start": [
                            "action": "start", "state": "not_started", "nothingRunning": true,
                            "failed": [
                                "stage": "desk_accepted", "reason": "Claude Code did not answer within 15 seconds",
                            ],
                        ],
                    ])
                }
                if draft != nil, step == "handed", LifeFixture.answer == "sending" {
                    try await Task.sleep(for: .seconds(3_600))
                }
                if draft != nil, step == "confirmed", Self.refused.contains(LifeFixture.answer) { break }
                if draft == nil, LifeFixture.answer == "failed" { throw MCPError.refused("Your Mac did not take it.") }
                onProgress(message(["step": step, "at": at(18, 14, 3)]))
            }
            if draft != nil, Self.refused.contains(LifeFixture.answer) {
                let send: [String: Any] =
                    switch LifeFixture.answer {
                    case "wroteSince":
                        [
                            "state": "not_sent", "canRetry": true,
                            "reason": "not sent: someone wrote in Hélène Aubert since this card was asked",
                            "wrote": [
                                "at": at(18, 17, 52), "by": "Hélène",
                                "text": "Finalement, pouvez-vous l'envoyer par courrier ?",
                            ],
                        ]
                    case "mayHaveGone":
                        [
                            "state": "may_have_gone",
                            "reason": "WhatsApp did not confirm. Check her chat before sending again.",
                        ]
                    default:
                        [
                            "state": "not_sent", "reason": "WhatsApp is not linked on your Mac.", "canRetry": true,
                        ]
                    }
                return json(["ref": answer.ref, "kind": "decision", "send": send])
            }
            if isNewMatter, answer.options == ["edit-goal"] {
                return json(["ref": answer.ref, "kind": "new matter"])
            }
            answered.withLock { _ = $0.insert(answer.ref) }
            var result: [String: Any] = [
                "ref": answer.ref, "kind": "decision", "asker": ["name": "Claude Code", "told": "recorded"],
            ]
            if draft != nil {
                result["send"] = ["state": "sent", "at": at(18, 14, 3), "channel": "whatsapp", "to": "Hélène Aubert"]
            } else if isNewMatter, answer.options == ["start"] {
                result["start"] = [
                    "action": "start", "state": "started", "nothingRunning": false, "runtime": "claude",
                    "stages": [["stage": "desk_accepted"], ["stage": "session_open"], ["stage": "turn_begun"]],
                ]
            } else if check?["group"] as? String == "voice" {
                result["changed"] = ["voices": 3, "conversations": 2]
            }
            return json(result)
        }

        func changeAgent(_ change: AgentRequest, onProgress: @escaping @Sendable (Data) -> Void) async throws -> String
        {
            try await gate()
            guard change.action == .start else {
                return json(["action": change.action.rawValue, "state": "done", "agent": change.agent ?? ""])
            }
            onProgress(message(["plan": ["desk_accepted", "session_open", "turn_begun"], "limitSeconds": 15]))
            try await Task.sleep(for: .milliseconds(900))
            onProgress(message(["step": "desk_accepted", "at": at(18, 14, 5)]))
            if LifeFixture.start == "starting" { try await Task.sleep(for: .seconds(3_600)) }
            if LifeFixture.start == "failed" {
                return json([
                    "action": "start", "state": "not_started", "nothingRunning": true,
                    "failed": ["stage": "desk_accepted", "reason": "Claude Code did not answer within 15 seconds"],
                ])
            }
            try await Task.sleep(for: .milliseconds(900))
            onProgress(message(["step": "session_open", "at": at(18, 14, 5)]))
            onProgress(message(["step": "turn_begun", "at": at(18, 14, 5)]))
            started.withLock { $0 = true }
            return json([
                "action": "start", "state": "started", "agent": "agt_table",
                "stages": [["stage": "turn_begun", "at": at(18, 14, 5), "link": "https://agents.example.test/s/9"]],
            ])
        }

        func setMatterDirection(
            matter: String, goal: String?, nextStep: NextStepRequest?, onProgress: @escaping @Sendable (Data) -> Void
        ) async throws -> String {
            try await Task.sleep(for: .milliseconds(500))
            return "{}"
        }

        func markDone(matter: String, note: String, onProgress: @escaping @Sendable (Data) -> Void) async throws
            -> String
        {
            try await Task.sleep(for: .milliseconds(500))
            return "{}"
        }

        // MARK: Made-up data

        private static func option(_ id: String, _ label: String, outgoing: Bool = false, takes: String? = nil)
            -> [String: Any]
        {
            var option: [String: Any] = ["id": id, "label": label]
            if outgoing { option["outgoing"] = true }
            if let takes { option["takes"] = takes }
            return option
        }

        /// The clips' recordings: a quiet tone of 50 s for each fixture job, put where `ClipAudio` finds it, so a clip plays
        /// with no lifelog behind it.
        private static func seedClipAudio() {
            for job in [clipJob1, clipJob2, clipJob3] { ClipAudio.writeTone(job: job, seconds: 50) }
        }

        private static func clip(_ at: String, _ text: String, job: String, from: Double, to: Double) -> [String: Any] {
            [
                "at": at, "until": at, "text": text, "audio": ["jobId": job, "start": from, "end": to],
                "words": timed(text),
            ]
        }

        nonisolated static let clipJob1 = "00000000-0000-0000-0000-0000000000C1"
        nonisolated static let clipJob2 = "00000000-0000-0000-0000-0000000000C2"
        nonisolated static let clipJob3 = "00000000-0000-0000-0000-0000000000C3"

        /// A clip's words timed 0.35 s apiece, each as `TimedWords` has it: start and end in ms, its length with the space before.
        private static func timed(_ text: String) -> [[Int]] {
            var from = text.startIndex
            return text.split(separator: " ", omittingEmptySubsequences: true).enumerated().map { index, word in
                let end = word.endIndex
                defer { from = end }
                return [index * 350, index * 350 + 300, text.utf16.distance(from: from, to: end)]
            }
        }

        private static func check(
            _ ref: String, group: String, urgency: String = "improves", title: String, question: String,
            asker: String = "life",
            options: [[String: Any]],
            matter: [String: Any]? = nil, deadline: String? = nil, context: String? = nil, extra: [String: Any] = [:]
        ) -> [String: Any] {
            var check: [String: Any] = [
                "ref": ref, "pushId": "push_\(ref)",
                "ridesOn": [
                    "observations": 14, "matterIds": [matter?["id"]].compactMap { $0 },
                    "matters": matter == nil ? 0 : 1,
                    "pages": 0,
                ],
                "group": group, "title": title, "question": question,
                "asker": asker, "urgency": urgency,
                "options": options, "clips": [], "likelyPeople": [], "links": [],
            ]
            if let matter { check["matter"] = matter }
            if let deadline { check["deadline"] = deadline }
            if let context { check["context"] = context }
            return check.merging(extra) { $1 }
        }

        nonisolated(unsafe) private static let lease: [String: Any] = [
            "id": "matter_lease", "name": "Lease renewal, rue des Carmes",
        ]
        nonisolated(unsafe) private static let nora: [String: Any] = [
            "id": "matter_nora", "name": "Quote for Nora Keller",
        ]
        nonisolated(unsafe) private static let table: [String: Any] = [
            "id": "matter_table", "name": "Table for Mum’s 60th",
        ]
        nonisolated(unsafe) private static let kitchen: [String: Any] = [
            "id": "matter_kitchen", "name": "Kitchen quote, Halden house",
        ]

        /// A guess Life asks beside a draft to a person it only guesses (`confirm`), and about a matter's person: the
        /// network's name for them, their number and their newest message, and the words it rests on.
        private static func guess(_ ref: String, name: String, handle: String, matter: [String: Any]? = nil)
            -> [String: Any]
        {
            check(
                ref, group: "guessed person", title: "A name Life can’t place: “\(handle)”, on WhatsApp",
                question: "Is this \(name)?",
                options: [
                    option("this-is", "Yes"), option("not-this-person", "No"),
                    option("same-person", "Someone else…", takes: "person"),
                ],
                matter: matter, context: "The same number is in his mail, and the chat opens with that name.",
                extra: [
                    "evidence": ["from": "\(name), mail, 9 Nov", "quote": "Mon numéro pro : 06 39 98 01 23"],
                    "networkIdentity": [
                        "network": "WhatsApp", "handle": "+33 6 39 98 01 23", "shownName": handle,
                        "chat": "33639980123@s.whatsapp.net", "openUrl": "https://wa.me/33639980123",
                        "newest": [
                            "at": at(17, 9, 14), "by": handle,
                            "text": "Bonjour, c’est Idris. Le prix du fournisseur arrive vendredi.",
                        ],
                    ],
                ])
        }

        /// In the server's own order (`inboxRankOf`): what blocks (decisions, voices, names, Contacts cards), then what
        /// improves (new matters, guessed people, endings).
        nonisolated(unsafe) static let checks: [[String: Any]] =
            [
                check(
                    "dec_plan", group: "decision", urgency: "blocks",
                    title: "Get the lease signed and back to Hélène Aubert",
                    question: "I draft your reply, ask you before sending, then watch for her answer. Go?",
                    asker: "Claude Code",
                    options: [option("go", "Go"), option("change", "Change"), option("stop", "Stop")], matter: lease,
                    deadline: at(19, 18),
                    context: "Hélène asked twice, the last time on Thursday. The lease ends on 31 December.",
                    extra: ["onSilence": "go", "links": ["https://agents.example.test/s/1"]]),
                check(
                    "dec_send", group: "decision", urgency: "blocks",
                    title: "Tell Hélène the signed lease is on its way",
                    question: "Send this to ~ Hélène A.?",
                    asker: "Claude Code",
                    options: [
                        option("send", "Send", outgoing: true), option("edit", "Edit"), option("no", "Don’t send"),
                    ],
                    matter: lease, deadline: at(19, 18), context: "She asked on Thursday whether it was signed. It is.",
                    extra: [
                        "onSilence": "no", "links": ["https://agents.example.test/s/1"],
                        "networkIdentity": [
                            "network": "WhatsApp", "handle": "+33600000001", "shownName": "Hélène A.",
                            "chat": "33600000001@s.whatsapp.net", "openUrl": "https://wa.me/33600000001",
                            "newest": [
                                "at": at(12, 10), "by": "Hélène Aubert",
                                "text": "Bonjour, avez-vous pu signer le bail ?",
                            ],
                        ],
                        "confirm": [guess("guess_helene", name: "Hélène Aubert", handle: "Hélène A.", matter: lease)],
                        "draft": [
                            "to": "Hélène Aubert", "channel": "whatsapp",
                            "text":
                                "Bonjour Hélène, oui, c’est signé. Je vous l’envoie ce soir en PDF. Bonne journée !",
                            "quoted": ["sender": "Hélène Aubert", "text": "Bonjour, avez-vous pu signer le bail ?"],
                        ],
                    ]),
            ]
            + [
                check(
                    "dec_long", group: "decision", urgency: "blocks", title: "Where Mum’s lunch should be",
                    question: "Where should Mum’s lunch be?", asker: "Claude Code",
                    options: [
                        option("odile", "Chez Odile on Friday, if they have a table"),
                        option("odile-sat", "Chez Odile, but on Saturday at noon instead"),
                        option("home", "At home, and Camille cooks for everyone"),
                        option("else", "Somewhere else, I will tell you where"),
                    ],
                    matter: table, deadline: at(20, 12),
                    context:
                        "Camille asked Friday or Saturday. Chez Odile holds a table for six until Thursday evening.",
                    extra: [
                        "onSilence": "odile",
                        "said": [
                            "at": at(14, 18), "by": "Camille Vance", "channel": "whatsapp", "to": "Sam",
                            "text": "On fait ça chez Odile ? Vendredi 27 ou samedi 28 ?",
                        ],
                        "onMatters": [table],
                    ])
            ]
            + (7...12).map { number in
                check(
                    "dec_\(number)", group: "decision", urgency: "blocks",
                    title: "Quote for Nora Keller, step \(number)",
                    question: "Confirm the start date with Nora?", asker: "Codex",
                    options: [option("yes", "Yes"), option("no", "Not yet")], matter: nora, deadline: at(20, 12))
            }
            + [
                check(
                    "voice_v1", group: "voice", urgency: "blocks", title: "A voice from Saturday, 4 minutes with Sam",
                    question: "Who is this?",
                    options: [
                        option("this-is", "Someone else…", takes: "person or name"),
                        option("not-relevant", "Don't name"),
                    ],
                    context: "Sam called the voice “Jun” twice in the same minute.",
                    extra: [
                        "likelyPeople": [
                            ["name": "Idris Benali", "person": "person:idris", "line": "Supplier, kitchen quote"]
                        ],
                        "clips": [
                            clip(
                                at(14, 10, 2), "On se retrouve au marché samedi, vers dix heures ?", job: clipJob1,
                                from: 1.2, to: 9.2),
                            clip(at(14, 10, 3), "D’accord, à samedi.", job: clipJob1, from: 20.0, to: 24.0),
                            clip(at(14, 10, 5), "Je t’envoie l’adresse.", job: clipJob1, from: 40.0, to: 43.0),
                        ],
                    ]),
                check(
                    "voice_long", group: "voice", urgency: "blocks", title: "A voice from Sunday, 12 minutes",
                    question: "Who is this?",
                    options: [
                        option("this-is", "Someone else…", takes: "person or name"),
                        option("not-relevant", "Don't name"),
                    ],
                    extra: [
                        "clips": [
                            clip(
                                at(15, 9, 40),
                                "Alors voilà, pour la cuisine il faudrait que je repasse mesurer le mur du fond, parce que les plans ne tiennent pas compte de la gaine, et que Idris me dit que le fournisseur ne livre pas avant mi-janvier si on ne confirme pas cette semaine.",
                                job: clipJob3, from: 3.0, to: 24.0)
                        ]
                    ]),
                check(
                    "voice_guess", group: "voice", urgency: "blocks", title: "A voice from Sunday, 8 seconds",
                    question: "Is this Jun Watanabe?",
                    options: [
                        option("this-is", "Yes"), option("not-this", "Someone else…", takes: "person or name"),
                        option("not-relevant", "Don't name"),
                    ],
                    extra: [
                        "clips": [
                            clip(
                                at(15, 18, 2), "Je t’envoie le plan demain.", job: clipJob2, from: 5.0, to: 13.0)
                        ]
                    ]),
                check(
                    "name_marc", group: "name", urgency: "blocks", title: "A name with no person: “Marc”",
                    question: "Who is “Marc”?",
                    options: [option("this-is", "Someone else…", takes: "person")],
                    matter: table, context: "Camille named him about the table.",
                    extra: [
                        "said": [
                            "at": at(14, 12), "by": "Camille Vance", "channel": "whatsapp", "to": "Sam",
                            "text": "Marc nous a trouvé une table pour huit chez Odile.",
                        ],
                        "around": [
                            "before": [
                                [
                                    "at": at(14, 11, 58), "by": "Sam", "channel": "whatsapp", "to": "Camille Vance",
                                    "text": "Tu as réussi à réserver ?",
                                ]
                            ],
                            "after": [
                                [
                                    "at": at(14, 12, 2), "by": "Sam", "channel": "whatsapp", "to": "Camille Vance",
                                    "text": "Génial, merci.",
                                ]
                            ],
                        ],
                        "about": ["Marc"],
                        "clips": [
                            clip(
                                at(14, 12), "Marc nous a trouvé une table pour huit chez Odile.", job: clipJob2,
                                from: 16.0, to: 21.0)
                        ],
                        "likelyPeople": [
                            ["name": "Marc Delmas", "person": "person:marc", "line": "Colleague, Camille’s brother"],
                            ["name": "Marcus Hale", "person": "person:marcus"],
                        ],
                        "onMatters": [table],
                    ]),
                check(
                    "person:con_marc", group: "contacts card", urgency: "blocks", title: "Place a Contacts card",
                    question: "Whose contact is this?",
                    options: [option("same-person", "Someone else…", takes: "person")],
                    context: "Its name and handles fit more than one person.",
                    extra: [
                        "contactsCard": ["name": "Marc", "handles": ["+33 6 39 98 02 14"]],
                        "likelyPeople": [
                            [
                                "name": "Marc Delmas", "person": "person:marc",
                                "line": "Fitter, works with Idris Benali",
                            ],
                            ["name": "Marc Fenn", "person": "person:marc_fenn", "line": "Camille’s brother"],
                        ],
                    ]),
                check(
                    "card_found", group: "new matter", title: "Life found a new matter: a table for Mum’s 60th",
                    question: "Start an agent on this?",
                    options: [
                        option("start", "Start"), option("edit-goal", "Edit goal", takes: "note"),
                        option("dismiss", "No"),
                    ],
                    matter: table,
                    context: "Camille proposed Chez Odile on Saturday; you said you would handle it.",
                    extra: [
                        "goal": "A table for eight at Chez Odile on Friday 27th.",
                        "said": [
                            "at": at(14, 18), "by": "Camille Vance", "channel": "whatsapp", "to": "Camille Vance",
                            "text": "On réserve chez Odile vendredi ?",
                        ],
                    ]),
                guess("guess_idris", name: "Idris Benali", handle: "Idris B.", matter: kitchen),
                check(
                    "name_cam", group: "guessed person", title: "A name Life can’t place: “Cam”, on WhatsApp",
                    question: "Is this Camille Vance?",
                    options: [
                        option("this-is", "Yes"), option("not-this-person", "No"),
                        option("same-person", "Someone else…", takes: "person"),
                    ],
                    extra: [
                        "evidence": ["from": "WhatsApp, Mon 9 Nov", "quote": "Cam: on se voit samedi au marché ?"],
                        "likelyPeople": [
                            ["name": "Idris Benali", "person": "person:idris"],
                            ["name": "Nora Keller", "person": "person:nora"],
                        ],
                    ]),
                check(
                    "end_done", group: "ending", title: "Idris Benali owed Sam the supplier price",
                    question: "Is this done?",
                    options: [option("outdated", "Yes, done"), option("false", "Not yet")], matter: kitchen,
                    context: "He wrote the price on Tuesday; nothing in the matter has changed since.",
                    extra: [
                        "said": [
                            "at": at(17, 16), "by": "Idris Benali", "channel": "messenger", "to": "Sam",
                            "text": "Je t’envoie le prix du fournisseur demain.",
                        ],
                        "since": [
                            "at": at(18, 9), "by": "Idris Benali", "channel": "messenger", "to": "Sam",
                            "text": "Voilà le prix du fournisseur : 4 200 € posé.",
                        ],
                        "onMatters": [kitchen],
                        "evidence": [
                            "from": "Idris Benali, Messenger, Tue 17 Nov",
                            "quote": "Voilà le prix du fournisseur : 4 200 € posé.",
                        ],
                    ]),
            ]

        nonisolated(unsafe) static let rows: [[String: Any]] = [
            row(
                "matter_lease", "Lease renewal, rue des Carmes", status: "moving",
                goal: "The signed lease is back with Hélène Aubert before 30 November.",
                next: ("wait_decision", "Send Hélène the signed lease."), areas: ["Home", "Money"],
                people: ["owedTo": ["Hélène Aubert"], "with": ["Camille Vance"]],
                agent: "agt_lease", opened: 9),
            row(
                "matter_table", "Table for Mum’s 60th", status: "moving",
                goal: "A table for eight at Chez Odile on Friday 27th.",
                next: ("do", "Book Chez Odile for Friday 27th."), areas: ["Family"],
                people: ["with": ["Camille Vance", "Idris Benali"]], opened: 3),
            row(
                "matter_nora", "Quote for Nora Keller", status: "moving", goal: "Quote sent and accepted.",
                next: ("wait_owner", "Call Nora about the start date."), areas: ["Work"],
                people: ["with": ["Nora Keller"]], opened: 5),
            row(
                "matter_kitchen", "Kitchen quote, Halden house", status: "waiting_on_someone",
                goal: "A kitchen quote that fits the budget.",
                next: ("wait_event", "The supplier price from Idris."), waitsOn: "a message", areas: ["Home"],
                people: ["waitingOn": ["Idris Benali"]],
                agent: "agt_kitchen", opened: 6),
            row(
                "matter_passport", "New passport", status: "moving", goal: "The new passport in hand.",
                next: ("wait_owner", "Pick it up at the town hall."),
                areas: ["Admin"], people: [:], opened: 12),
            row(
                "matter_shelf", "Bookshelf delivery", status: "waiting_on_someone",
                goal: "The bookshelf is in the flat.",
                next: ("wait_event", "The delivery, due Saturday 21st."), waitsOn: "a delivery", areas: ["Home"],
                people: [:], opened: 4),
            row(
                "matter_intro", "Intro to Jun’s ops lead", status: "stuck", goal: "Jun’s ops lead has met Priya Nair.",
                next: ("wait_event", "Jun replies."), waitsOn: "Jun Watanabe", areas: ["Work"],
                people: ["waitingOn": ["Jun Watanabe"], "with": ["Priya Nair"]], opened: 15),
        ]

        private static func row(
            _ id: String, _ name: String, status: String, goal: String, next: (String, String), waitsOn: String? = nil,
            areas: [String], people: [String: [String]], agent: String? = nil, opened: Int
        ) -> [String: Any] {
            var step: [String: Any] = ["kind": next.0, "text": next.1, "by": "life"]
            if let waitsOn { step["waitsOn"] = waitsOn }
            var row: [String: Any] = [
                "id": id, "name": name, "status": status, "goal": ["by": "life", "text": goal], "nextStep": step,
                "areas": areas,
                "people": people, "lastStepAt": at(18, 14, 2), "openedDaysAgo": opened,
            ]
            if let agent { row["agent"] = agent }
            return row
        }

        static func agent(_ index: Int) -> [String: Any] {
            let common: [String: Any] = [
                "amber": [], "effort": "medium", "steps": [], "project": NSNull(), "outcome": NSNull(),
            ]
            let lease: [String: Any] = [
                "id": "agt_lease", "title": "Get the lease signed and back to Hélène Aubert", "runtime": "claude",
                "model": "Sonnet",
                "status": "waiting", "link": "https://agents.example.test/s/1", "notes": "Lease renewal.",
                "wait": ["isDefault": false, "reason": "Hélène sends the signed lease.", "until": at(21, 18)],
                "statusSince": at(19, 14, 2),
                "wakesOn": [
                    ["kind": "message", "person": "Hélène Aubert", "calls": true],
                    ["kind": "message", "person": "Camille Vidal", "calls": true, "apps": ["whatsapp"]],
                    [
                        "kind": "message", "calls": true, "apps": ["whatsapp"],
                        "chat": ["name": "Carmes building", "app": "whatsapp", "group": true],
                    ],
                    ["kind": "message", "person": "Léa Marchetti", "calls": true, "broken": "unknown_person"],
                    ["kind": "message", "calls": true, "chat": ["name": NSNull(), "app": "line", "group": NSNull()]],
                    ["kind": "message", "person": "Hélène Aubert", "words": "bail", "calls": false],
                    ["kind": "message", "words": "devis", "calls": false, "apps": ["mail"]],
                    [
                        "kind": "message", "fromHim": true, "calls": false,
                        "chat": ["name": "Carmes building", "app": "whatsapp", "group": true],
                    ],
                    ["kind": "payments", "quantity": "eur_out", "above": 500],
                    ["kind": "places", "where": "Halden house"],
                    ["kind": "answer", "card": "Go with this plan?", "check": "dec_plan", "deadline": at(19, 18)],
                    ["kind": "wide_net"],
                ],
                "lastTurn": [
                    "startedAt": at(18, 14, 0), "endedAt": at(18, 14, 2),
                    "outcome": "drafted the reply to Hélène and asked you to send it",
                ],
            ]
            let kitchen: [String: Any] = [
                "id": "agt_kitchen", "title": "Get the kitchen supplier price", "runtime": "codex", "model": "GPT",
                "status": "waiting", "link": NSNull(), "notes": "Kitchen quote.",
                "wait": ["isDefault": true, "reason": "a message", "until": at(20, 18)],
                "statusSince": at(19, 14, 2),
                "wakesOn": [
                    ["kind": "message", "person": "Idris Benali", "calls": true],
                    ["kind": "message", "words": "devis", "calls": false, "apps": ["mail"]],
                    ["kind": "payments", "quantity": "eur_out", "above": 500],
                    ["kind": "places", "where": "Halden house"],
                    ["kind": "answer", "card": "Go with this plan?", "check": "dec_plan", "deadline": at(20, 18)],
                    ["kind": "wide_net"],
                ],
                "lastTurn": [
                    "startedAt": at(17, 10, 0), "endedAt": at(17, 10, 4), "outcome": "asked Idris for the price",
                ],
            ]
            let table: [String: Any] = [
                "id": "agt_table", "title": "Book Chez Odile", "runtime": "claude", "model": "Sonnet",
                "status": "running",
                "link": "https://agents.example.test/s/9", "notes": "Table.", "wait": NSNull(),
                "statusSince": at(18, 14, 5), "wakesOn": [],
                "lastTurn": ["startedAt": at(18, 14, 5), "endedAt": NSNull(), "outcome": NSNull()],
            ]
            let matter: [Int: [String: Any]] = [
                0: ["id": "matter_lease", "name": "Lease renewal, rue des Carmes", "status": "moving"],
                1: ["id": "matter_kitchen", "name": "Kitchen quote, Halden house", "status": "waiting_on_someone"],
                2: ["id": "matter_table", "name": "Table for Mum’s 60th", "status": "moving"],
                3: ["id": "matter_nora", "name": "Quote for Nora Keller", "status": "moving"],
            ]
            let stopped: [String: Any] = [
                "id": "agt_nora", "title": "Quote for Nora Keller", "runtime": "claude", "model": "Sonnet",
                "status": "stopped", "link": "https://agents.example.test/s/4", "notes": "Quote.", "wait": NSNull(),
                "statusSince": at(19, 14, 10), "wakesOn": [], "lastTurn": NSNull(),
            ]
            let body = [lease, kitchen, table, stopped][index]
            return common.merging(body) { $1 }.merging(["matter": matter[index] ?? NSNull()]) { $1 }
        }

        static func steps(_ id: String) -> [[String: Any]] {
            func step(
                _ n: Int, _ ref: String, _ day: Int, _ hour: Int, _ kind: String, _ text: String, _ quote: String,
                with: String? = nil, ended: Bool = false
            ) -> [String: Any] {
                var step: [String: Any] = [
                    "ref": ref, "at": at(day, hour), "day": "2026-11-\(day)", "kind": kind, "text": text,
                    "quote": quote,
                ]
                if let with { step["with"] = with }
                if ended { step["ending"] = ["at": at(day, hour + 1), "by": "ticked"] }
                return step
            }
            if id == "matter_table" {
                return [
                    step(
                        2, "ep_t2", 14, 11, "observation", "He agrees", "Vendredi c’est bon pour nous.",
                        with: "Idris Benali, WhatsApp"),
                    step(
                        3, "ep_t3", 14, 12, "observation", "She proposes", "On fait ça chez Odile ? Vendredi 27 ?",
                        with: "Camille Vance, WhatsApp"),
                    step(
                        4, "obs_t4", 15, 9, "promise", "Your promise", "Je m’occupe du resto pour les 60 ans de maman.",
                        with: "heard by the pendant"),
                ]
            }
            return [
                step(
                    7, "ep_l7", 12, 10, "observation", "She asks again", "Bonjour, avez-vous pu signer le bail ?",
                    with: "Hélène Aubert, WhatsApp"),
                step(8, "obs_l8", 12, 11, "todo_item", "Sign the lease and send it back", "", with: "your to-do list"),
                step(9, "obs_l9", 18, 14, "agent", "Drafted the reply and asked to send it", "", with: "Claude Code"),
            ]
        }
    }
#endif
