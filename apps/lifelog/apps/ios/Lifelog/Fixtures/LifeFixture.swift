#if DEBUG
    import Foundation
    import Library
    import LifeConnector
    import Synchronization

    /// Life without a Mac, for the simulator: made-up inbox, matters and agents, and an API that answers as Life would,
    /// slowly, or not at all, so every state of every screen can be put on screen and photographed.
    ///
    /// `-fixtureLife <scenario>` turns it on: `ok`, `loading`, `empty`, `stale`, `unreachable`, `failed`, `notPaired`.
    /// `-fixtureAnswer sent|sending|notSent` decides what a tap on a draft does; `-fixtureStart started|starting|failed`
    /// what "Start" does. `-fixtureCard <ref>`, `-fixtureTab matters`, `-fixtureMatter <id>`, and `-fixtureSheet pendant|settings|pair|pairing`
    /// open the screen to show. `-fixturePose wide|upright` draws the iPhone Duo open (`DuoPose`).
    enum LifeFixture {
        nonisolated static let scenario = value(of: "-fixtureLife")
        nonisolated static var isRequested: Bool { scenario != nil }
        nonisolated static let answer = value(of: "-fixtureAnswer") ?? "sent"
        nonisolated static let start = value(of: "-fixtureStart") ?? "started"
        nonisolated static let card = value(of: "-fixtureCard")
        nonisolated static let tab = value(of: "-fixtureTab")
        nonisolated static let matter = value(of: "-fixtureMatter")
        nonisolated static let sheet = value(of: "-fixtureSheet")
        /// What approving a pairing does: `ok` (after a moment), `slow` (never ends), `expired` (the code is refused).
        /// `-fixturePage life|server|diagnostics`: Settings opens that page.
        nonisolated static let page = value(of: "-fixturePage")
        nonisolated static let pair = value(of: "-fixturePair") ?? "ok"
        nonisolated static let pose = value(of: "-fixturePose")

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

        init(scenario: String) { self.scenario = scenario }

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

        func readInbox() async throws -> String { try await gate(); return inbox() }
        func readMatters() async throws -> String { try await gate(); return matters() }
        func readRegisteredAgents() async throws -> String { try await gate(); return agents() }

        func readMatter(_ id: String) async throws -> String {
            try await gate()
            guard let row = Self.rows.first(where: { $0["id"] as? String == id }) else {
                throw MCPError.failed("No such matter.")
            }
            var matter = row
            let hasAgent = id == "matter_lease" || (id == "matter_table" && started.withLock { $0 })
            matter["agents"] = hasAgent ? [Self.agent(id == "matter_lease" ? 0 : 2)] : []
            if id == "matter_table", started.withLock({ $0 }) { matter["agent"] = "agt_table" }
            matter["steps"] = Self.steps(id)
            return json(matter)
        }

        func inbox() -> String {
            let left = answered.withLock { $0 }
            let checks = scenario == "empty" ? [] : Self.checks.filter { !left.contains($0["ref"] as? String ?? "") }
            return json([
                "checks": checks, "counts": ["decision": checks.count], "total": checks.count, "deadlinesToday": 1,
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
                    ? ["goal_saved", "desk_accepted", "session_open", "turn_begun", "left_inbox"]
                    : answer.options == ["edit-goal"] ? ["goal_saved"] : ["recorded", "left_inbox"])
                : draft == nil
                    ? ["recorded", "asker_told", "left_inbox"]
                    : ["recorded", "chat_checked", "handed", "confirmed", "asker_told", "left_inbox"]
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
                if draft != nil, step == "confirmed", LifeFixture.answer == "notSent" { break }
                onProgress(message(["step": step, "at": at(18, 14, 3)]))
            }
            if draft != nil, LifeFixture.answer == "notSent" {
                return json([
                    "ref": answer.ref, "kind": "decision",
                    "send": [
                        "state": "not_sent", "reason": "WhatsApp did not confirm within 20 seconds", "canRetry": true,
                    ],
                ])
            }
            if isNewMatter, answer.options == ["edit-goal"] {
                return json([
                    "ref": answer.ref, "kind": "new matter",
                    "inbox": ["left": false, "total": 12, "deadlinesToday": 0],
                ])
            }
            answered.withLock { _ = $0.insert(answer.ref) }
            var result: [String: Any] = [
                "ref": answer.ref, "kind": "decision", "asker": ["name": "Claude Code", "told": "recorded"],
                "inbox": ["left": true, "total": 11, "deadlinesToday": 0],
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

        func setMatterDirection(matter: String, goal: String?, nextStep: NextStepRequest?) async throws -> String {
            try await Task.sleep(for: .milliseconds(500))
            return "{}"
        }

        func markDone(matter: String, note: String) async throws -> String {
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

        private static func check(
            _ ref: String, group: String, title: String, question: String, asker: String = "life",
            options: [[String: Any]],
            matter: [String: Any]? = nil, deadline: String? = nil, context: String? = nil, extra: [String: Any] = [:]
        ) -> [String: Any] {
            var check: [String: Any] = [
                "ref": ref, "pushId": "push_\(ref)", "ridesOn": ["observations": 14, "matters": 2, "pages": 0],
                "group": group, "title": title, "question": question,
                "asker": asker,
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
        nonisolated(unsafe) private static let table: [String: Any] = [
            "id": "matter_table", "name": "Table for Mum’s 60th",
        ]
        nonisolated(unsafe) private static let kitchen: [String: Any] = [
            "id": "matter_kitchen", "name": "Kitchen quote, Halden house",
        ]

        nonisolated(unsafe) static let checks: [[String: Any]] =
            [
                check(
                    "dec_plan", group: "decision", title: "Get the lease signed and back to Hélène Aubert",
                    question: "I draft your reply, ask you before sending, then watch for her answer. Go?",
                    asker: "Claude Code",
                    options: [option("go", "Go"), option("change", "Change"), option("stop", "Stop")], matter: lease,
                    deadline: at(19, 18),
                    context: "Hélène asked twice, the last time on Thursday. The lease ends on 31 December.",
                    extra: ["onSilence": "stop", "links": ["https://agents.example.test/s/1"]]),
                check(
                    "dec_send", group: "decision", title: "Tell Hélène the signed lease is on its way",
                    question: "Send this to her?",
                    asker: "Claude Code",
                    options: [
                        option("send", "Send", outgoing: true), option("edit", "Edit"), option("no", "Don’t send"),
                    ],
                    matter: lease, deadline: at(19, 18), context: "She asked on Thursday whether it was signed. It is.",
                    extra: [
                        "onSilence": "no", "links": ["https://agents.example.test/s/1"],
                        "draft": [
                            "to": "Hélène Aubert", "channel": "whatsapp",
                            "text":
                                "Bonjour Hélène, oui, c’est signé. Je vous l’envoie ce soir en PDF. Bonne journée !",
                            "quoted": ["sender": "Hélène Aubert", "text": "Bonjour, avez-vous pu signer le bail ?"],
                        ],
                    ]),
                check(
                    "end_done", group: "ending", title: "Idris Benali owed Sam the supplier price",
                    question: "Is this done?",
                    options: [option("outdated", "Done"), option("false", "Not done")], matter: kitchen,
                    context: "He wrote the price on Tuesday; nothing in the matter has changed since.",
                    extra: [
                        "evidence": [
                            "from": "Idris Benali, Messenger, Tue 17 Nov",
                            "quote": "Voilà le prix du fournisseur : 4 200 € posé.",
                        ]
                    ]),
                check(
                    "name_cam", group: "guessed person", title: "A name Life can’t place: “Cam”, on WhatsApp",
                    question: "Life thinks this is Camille Vance, a friend (70% sure)",
                    options: [
                        option("this-is", "It is them"), option("not-this-person", "Not them"),
                        option("same-person", "Someone Life already knows", takes: "person"),
                    ],
                    extra: [
                        "evidence": ["from": "WhatsApp, Mon 9 Nov", "quote": "Cam: on se voit samedi au marché ?"],
                        "likelyPeople": [
                            ["name": "Idris Benali", "person": "person:idris"],
                            ["name": "Nora Keller", "person": "person:nora"],
                        ],
                    ]),
                check(
                    "voice_v1", group: "voice", title: "A voice from Saturday, 4 minutes with Sam",
                    question: "Who is this voice?",
                    options: [
                        option("this-is", "It is this person", takes: "person or name"),
                        option("not-anyone-i-know", "Not anyone I know"), option("media", "A video or TV playing"),
                        option("not-relevant", "Not worth naming"),
                    ],
                    context: "Sam called the voice “Jun” twice in the same minute.",
                    extra: [
                        "likelyPeople": [["name": "Idris Benali", "person": "person:idris"]],
                        "clips": [
                            [
                                "at": at(14, 10, 2), "until": at(14, 10, 2),
                                "text": "On se retrouve au marché samedi, vers dix heures ?",
                                "audio": ["jobId": "job-1", "start": 1.2, "end": 9.2],
                            ],
                            [
                                "at": at(14, 10, 3), "until": at(14, 10, 3), "text": "D’accord, à samedi.",
                                "audio": ["jobId": "job-1", "start": 20.0, "end": 24.0],
                            ],
                            [
                                "at": at(14, 10, 5), "until": at(14, 10, 5), "text": "Je t’envoie l’adresse.",
                                "audio": ["jobId": "job-1", "start": 40.0, "end": 43.0],
                            ],
                        ],
                    ]),
                check(
                    "card_found", group: "new matter", title: "Life found a new matter: a table for Mum’s 60th",
                    question: "Goal: a table for eight at Chez Odile on Friday 27th. Work on it?",
                    options: [
                        option("start", "Start"), option("edit-goal", "Edit goal", takes: "note"),
                        option("dismiss", "Dismiss"),
                    ],
                    matter: table,
                    context: "Camille proposed Chez Odile on Saturday; you said you would handle it.",
                    extra: ["goal": "A table for eight at Chez Odile on Friday 27th."]),
                check(
                    "person:con_cam", group: "contacts card", title: "Place a Contacts card",
                    question:
                        "Life cannot place the Contacts card Cam: its name and handles say Camille Vance and Cam Ortiz",
                    options: [option("same-person", "It is this person", takes: "person")],
                    context: "Its name and handles fit more than one person: Life keeps them apart until you say.",
                    extra: [
                        "likelyPeople": [
                            ["name": "Camille Vance", "person": "person:camille"],
                            ["name": "Cam Ortiz", "person": "person:cam"],
                        ]
                    ]),
            ]
            + (7...12).map { number in
                check(
                    "dec_\(number)", group: "decision", title: "Quote for Nora Keller, step \(number)",
                    question: "Confirm the start date with Nora?", asker: "Codex",
                    options: [option("yes", "Yes"), option("no", "Not yet")], matter: kitchen, deadline: at(20, 12))
            }

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
                "wait": ["isDefault": false, "reason": "your answer", "until": at(19, 18)],
                "lastTurn": [
                    "startedAt": at(18, 14, 0), "endedAt": at(18, 14, 2),
                    "outcome": "drafted the reply to Hélène and asked you to send it",
                ],
            ]
            let kitchen: [String: Any] = [
                "id": "agt_kitchen", "title": "Get the kitchen supplier price", "runtime": "codex", "model": "GPT",
                "status": "waiting", "link": NSNull(), "notes": "Kitchen quote.",
                "wait": ["isDefault": true, "reason": "a message", "until": at(20, 9)],
                "lastTurn": [
                    "startedAt": at(17, 10, 0), "endedAt": at(17, 10, 4), "outcome": "asked Idris for the price",
                ],
            ]
            let table: [String: Any] = [
                "id": "agt_table", "title": "Book Chez Odile", "runtime": "claude", "model": "Sonnet",
                "status": "running",
                "link": "https://agents.example.test/s/9", "notes": "Table.", "wait": NSNull(),
                "lastTurn": ["startedAt": at(18, 14, 5), "endedAt": NSNull(), "outcome": NSNull()],
            ]
            let matter: [Int: [String: Any]] = [
                0: ["id": "matter_lease", "name": "Lease renewal, rue des Carmes", "status": "moving"],
                1: ["id": "matter_kitchen", "name": "Kitchen quote, Halden house", "status": "waiting_on_someone"],
                2: ["id": "matter_table", "name": "Table for Mum’s 60th", "status": "moving"],
            ]
            let body = [lease, kitchen, table][index]
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
