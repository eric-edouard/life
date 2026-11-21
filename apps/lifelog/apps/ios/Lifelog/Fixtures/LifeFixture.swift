#if DEBUG
    import Foundation
    import Library
    import LifeConnector
    import Synchronization
    import Upload

    /// Life without a Mac, for the simulator: the design data's made-up inbox, matters and agents, and an API that answers as Life would,
    /// slowly, or not at all, so every state of every screen can be put on screen and photographed.
    ///
    /// `-fixtureLife <scenario>` turns it on: `ok`, `many` (261 asks, for measuring the swipe), `groups` (three that block, then all that can wait), `loading`, `empty`, `improves` (only what can wait), `stale`, `slowPush` (every whole read after the first takes 5 s: a tapped push's card is checked), `slowInbox` (every whole read after the first takes 30 s), `unreachable`, `failed`, `notPaired`.
    /// `-fixtureAnswer sent|sending|notSent|wroteSince|mayHaveGone` decides what a tap on a draft does (`failed`: any other answer is refused; `sending`: it never ends); `-fixtureStart started|starting|failed`
    /// what "Start" does. `-fixtureCard <ref>`, `-fixtureTab matters|people|search`, `-fixtureMatter <id>`, `-fixtureProject <id>` (its page, pushed on the matter), `-fixturePerson <ref>`, `-fixtureUnmarked <matter id>`, `-fixtureParked <project id>`, and `-fixtureSheet pendant|settings|agent|icon|pair|pairing|replacePendant|pairPendant|create`
    /// open the screen to show (`create` holds Created, to be photographed). `-fixturePose wide|upright` draws the iPhone Duo open (`DuoPose`).
    enum LifeFixture {
        nonisolated static let scenario = value(of: "-fixtureLife")
        nonisolated static var isRequested: Bool { scenario != nil }
        nonisolated static let answer = value(of: "-fixtureAnswer") ?? "sent"
        nonisolated static let start = value(of: "-fixtureStart") ?? "started"
        /// Life's outcome on the transfer card (`dec_pay`): looking, not_found or seen; none by default.
        nonisolated static let doneSeen = value(of: "-fixtureDoneSeen")
        nonisolated static let card = value(of: "-fixtureCard")
        /// `-fixtureOnly <ref>`: the inbox holds that one card, for a screenshot of a card that is not the first.
        nonisolated static let tab = value(of: "-fixtureTab")
        nonisolated static let matter = value(of: "-fixtureMatter")
        nonisolated static let project = value(of: "-fixtureProject")
        /// `-fixturePerson <ref>`: the People tab opens on that person's or organization's page.
        nonisolated static let person = value(of: "-fixturePerson")
        /// `-fixtureUnmarked <matter id>`: that matter starts without his mark; `-fixtureParked <project id>`: that
        /// project starts parked.
        nonisolated static let unmarked = value(of: "-fixtureUnmarked")
        nonisolated static let parked = value(of: "-fixtureParked")
        nonisolated static let sheet = value(of: "-fixtureSheet")
        /// `-fixtureAgent notStarted|running`: Nora's agent never began (its runtime refused), for the Try again swap, or works.
        nonisolated static let agent = value(of: "-fixtureAgent")
        /// What approving a pairing does: `ok` (after a moment), `slow` (never ends), `expired` (the code is refused).
        /// `-fixturePage life|server|diagnostics`: Settings opens that page.
        nonisolated static let page = value(of: "-fixturePage")
        nonisolated static let pair = value(of: "-fixturePair") ?? "ok"
        nonisolated static let pose = value(of: "-fixturePose")
        /// `-fixtureReads <folder>`: where the design data is read, by default this checkout's
        /// `apps/lifelog/fixtures/design/` (`FixtureAPI`).
        nonisolated static let reads =
            value(of: "-fixtureReads")
            ?? URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../../fixtures/design")
            .standardized.path
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
        /// His "Wrong…" the caretaker received, by card: the card stays, being fixed.
        private let fixing = Mutex([String: String]())
        private let started = Mutex(false)
        private let wholeReads = Mutex(0)
        /// His marks and the projects' statuses as he set them here, over the design data.
        private let marks = Mutex(LifeFixture.unmarked.map { [$0: false] } ?? [String: Bool]())
        private let statuses = Mutex(LifeFixture.parked.map { [$0: "parked"] } ?? [String: String]())
        /// His icon picks, by matter: a key, or nil when he gave it back to Life (the design data's pick shows again).
        private let icons = Mutex([String: String?]())
        /// His Remove (true) or Undo (false) of the design data's appointment here.
        private let removed = Mutex<Bool?>(nil)

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
            if let wait = ["slowInbox": 30, "slowPush": 5][scenario],
                wholeReads.withLock({
                    $0 += 1; return $0
                }) > 1
            {
                try await Task.sleep(for: .seconds(wait))
            }
            return inbox()
        }
        func readInbox(pushId: String, at origin: URL?) async throws -> String {
            try await gate()
            // A push's read: just that card, none once answered.
            var one = (try? JSONSerialization.jsonObject(with: Data(inbox().utf8))) as? [String: Any] ?? [:]
            one["checks"] = (one["checks"] as? [[String: Any]] ?? []).filter { $0["pushId"] as? String == pushId }
            return json(one)
        }
        func readMatters() async throws -> String { try await gate(); return matters() }
        func readMatters(project: String) async throws -> String {
            try await gate()
            var head = Self.projectRead["project"] as? [String: Any] ?? [:]
            guard head["id"] as? String == project else { throw MCPError.failed("No such project.") }
            let rows = rowsNow().filter { ($0["project"] as? [String: Any])?["id"] as? String == project }
            let status = statuses.withLock { $0[project] } ?? head["status"] as? String ?? "active"
            head["status"] = status
            return json(["project": head, "matters": rows])
        }
        /// The matters whose people name `person`, by any role.
        func readMatters(person: String) async throws -> String {
            try await gate()
            let rows = rowsNow().filter { row in
                (row["people"] as? [String: [[String: Any]]] ?? [:]).values.joined().contains {
                    $0["ref"] as? String == person
                }
            }
            return json(["matters": rows])
        }
        func readRegisteredAgents() async throws -> String { try await gate(); return agents() }
        /// A `life:` link's page: what Life read of it, as its text reads.
        func fetch(_ ref: String) async throws -> String {
            try await gate()
            return LifeLinkRead.heading + "\n\n" + ref
        }
        /// The made-up cast's pictures (`pictures/<id>.jpg` beside the design data, `reads`), as Life sends them.
        func readPersonPictures(_ ids: [String]) async throws -> String {
            try await gate()
            let folder = URL(filePath: LifeFixture.reads).appending(path: "pictures")
            let found = ids.compactMap { id in
                (try? Data(contentsOf: folder.appending(path: id + ".jpg"))).map {
                    ["id": id, "mime": "image/jpeg", "data": $0.base64EncodedString()]
                }
            }
            return json(["pictures": found, "missing": ids.filter { id in !found.contains { $0["id"] == id } }])
        }

        /// The design data's people (`read_people_and_organizations.json`, its rows as the list gives them, and `others`);
        /// a query keeps the rows whose name holds it. None until the designer writes the file.
        func readPeopleAndOrganizations(query: String?) async throws -> String {
            try await gate()
            let rows = Self.people["people"] as? [[String: Any]] ?? []
            guard let query else { return json(["people": rows]) }
            let found = rows.filter { ($0["name"] as? String)?.localizedStandardContains(query) == true }
            return json(["people": found, "others": Self.people["others"] ?? []])
        }

        /// A part by its ref: someone's `now` (their row, with what `read_people_and_organizations_now.json` holds for
        /// their ref), a page of `latest` or `reach` (`read_people_and_organizations_latest.json`, `…_reach.json`, by
        /// ref) or a prose part.
        func readPart(_ ref: String) async throws -> String {
            try await gate()
            let parts = ref.split(separator: "/").map(String.init)
            guard let subject = parts.first, let part = parts.dropFirst().first else {
                throw MCPError.failed("No such part.")
            }
            // A page of `latest` or `reach`, by its whole ref (`person:camille/latest/before/2026-11-10`); `latest`
            // alone may be keyed by its subject.
            if part == "latest" || part == "reach" {
                let pages = Self.read("read_people_and_organizations_\(part)", or: [:])
                guard let page = pages[ref] ?? (ref == subject + "/latest" ? pages[subject] : nil) else {
                    if part == "latest", ref == subject + "/latest" { return json(["latest": []]) }
                    throw MCPError.failed("No such page.")
                }
                return json(page)
            }
            // A prose part, as Life writes it (`read_people_and_organizations_parts.json`, its text by ref).
            if part != "now" {
                return Self.read("read_people_and_organizations_parts", or: [:])[ref] as? String ?? ""
            }
            let rows = Self.people["people"] as? [[String: Any]] ?? []
            guard part == "now", let row = rows.first(where: { $0["ref"] as? String == subject }) else {
                throw MCPError.failed("No such person.")
            }
            let now = Self.read("read_people_and_organizations_now", or: [:])[subject] as? [String: Any] ?? [:]
            return json(row.merging(now) { $1 })
        }

        func readMatter(_ id: String) async throws -> String {
            try await gate()
            guard let row = rowsNow().first(where: { $0["id"] as? String == id }) else {
                throw MCPError.failed("No such matter.")
            }
            // The table's agent exists only once he started one; every open check about it, of every kind.
            let isStarted = started.withLock { $0 }
            var matter = DesignReplies.matter(
                row, agents: Self.allAgents.filter { $0["id"] as? String != "agt_table" || isStarted },
                steps: Self.matterRead["steps"] as? [String: Any] ?? [:], checks: checksNow())
            if id == "matter_table", isStarted { matter["agent"] = "agt_table" }
            // Nora's page stays short, so the agent's row shows above the fold.
            if id == "matter_nora" { matter["checks"] = Array((matter["checks"] as? [[String: Any]] ?? []).prefix(1)) }
            return json(matter)
        }

        /// The open asks as Life holds them now: less those he answered; one whose "Wrong…" the caretaker has no longer blocks.
        private func checksNow() -> [[String: Any]] {
            let (left, fixing) = (answered.withLock { $0 }, fixing.withLock { $0 })
            return Self.checks.filter { !left.contains($0["ref"] as? String ?? "") }.map { check in
                guard let ask = fixing[check["ref"] as? String ?? ""] else { return check }
                var check = check
                check["beingFixed"] = ["ask": ask, "since": at(18, 14, 3), "line": NSNull()]
                check["urgency"] = "improves"
                return check
            }
        }

        /// Every open ask, what blocks first, as `read_inbox` sends it; `improves` holds only what can wait (the list's
        /// "The rest can wait" first), `empty` nothing.
        func inbox() -> String {
            let left = answered.withLock { $0 }
            var open = checksNow().filter { scenario != "improves" || $0["urgency"] as? String == "improves" }
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
            // A card's matter carries his mark as the rows do.
            let marked = Set(rowsNow().filter { $0["important"] as? Bool == true }.compactMap { $0["id"] as? String })
            let checks = (scenario == "empty" ? [] : shown).map { check in
                // A guess already answered is no longer asked beside its draft.
                var check = check
                check["confirm"] = (check["confirm"] as? [[String: Any]] ?? []).filter {
                    !left.contains($0["ref"] as? String ?? "")
                }
                if var matter = check["matter"] as? [String: Any] {
                    matter["important"] = marked.contains(matter["id"] as? String ?? "") ? true : nil
                    check["matter"] = matter
                }
                return check
            }
            return json(DesignReplies.inbox(Self.inboxRead, checks: checks))
        }

        func matters() -> String {
            json(DesignReplies.matters(rowsNow()))
        }

        /// The rows with his marks and the projects' statuses applied, in Life's order: the marked first, a parked or
        /// done project's matters last, each group in the design data's order.
        private func rowsNow() -> [[String: Any]] {
            let (marks, statuses, icons) = (marks.withLock { $0 }, statuses.withLock { $0 }, icons.withLock { $0 })
            let rows = Self.rows.map { row in
                var row = row
                if case let key?? = icons[row["id"] as? String ?? ""] { row["icon"] = ["by": "owner", "key": key] }
                if let isOn = marks[row["id"] as? String ?? ""] { row["important"] = isOn ? true : nil }
                if var project = row["project"] as? [String: Any], let status = statuses[project["id"] as? String ?? ""]
                {
                    project["status"] = status
                    row["project"] = project
                }
                return row
            }
            func tier(_ row: [String: Any]) -> Int {
                let status = (row["project"] as? [String: Any])?["status"] as? String ?? "active"
                if !["active", "waiting"].contains(status) { return 2 }
                return row["important"] as? Bool == true ? 0 : 1
            }
            return rows.enumerated().sorted { (tier($0.element), $0.offset) < (tier($1.element), $1.offset) }.map(
                \.element)
        }

        func agents() -> String { json(Self.registered) }

        // MARK: Actions

        private func message(_ object: [String: Any]) -> Data {
            (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        }

        /// The `-fixtureAnswer` values where a send ends without going.
        private static let refused: Set = ["notSent", "wroteSince", "mayHaveGone"]

        func answerCheck(
            _ answer: AnswerRequest, answerKey: String, at origin: URL, onProgress: @escaping @Sendable (Data) -> Void
        ) async throws -> String {
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
                if draft == nil, LifeFixture.answer == "sending" { try await Task.sleep(for: .seconds(3_600)) }
                onProgress(message(["step": step, "at": at(18, 14, 3)]))
            }
            if answer.isComplaint {
                let ask = "complaint:" + answerKey
                fixing.withLock { $0[answer.ref] = ask }
                return json(["ask": ask, "reached": "caretaker"])
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

        func setMatterIcon(matter: String, icon: String?, onProgress: @escaping @Sendable (Data) -> Void)
            async throws -> String
        {
            try await gate()
            onProgress(message(["plan": ["recorded"], "limitSeconds": 5]))
            try await Task.sleep(for: .milliseconds(500))
            icons.withLock { $0[matter] = .some(icon) }
            return "Done: memory."
        }

        func markDone(matter: String, note: String, onProgress: @escaping @Sendable (Data) -> Void) async throws
            -> String
        {
            try await Task.sleep(for: .milliseconds(500))
            return "{}"
        }

        func setImportant(matter: String, _ important: Bool, onProgress: @escaping @Sendable (Data) -> Void)
            async throws -> String
        {
            try await gate()
            onProgress(message(["plan": ["recorded"], "limitSeconds": 5]))
            try await Task.sleep(for: .milliseconds(300))
            marks.withLock { $0[matter] = important }
            return "Done: memory."
        }

        func setProjectStatus(
            _ project: String, _ status: ProjectStatus, said: String, onProgress: @escaping @Sendable (Data) -> Void
        ) async throws -> String {
            try await gate()
            try await Task.sleep(for: .milliseconds(300))
            statuses.withLock { $0[project] = status.rawValue }
            return "Done: project \(project)."
        }

        /// The design data's appointment (`read_appointments.json`), when the designer has written one; removed or not
        /// as he set it here.
        func readAppointment(_ key: AppointmentKey, at origin: URL?) async throws -> String {
            try await gate()
            var read = Self.read("read_appointments", or: [:])
            guard !read.isEmpty else { throw MCPError.failed("No appointment in the design data.") }
            if let removed = removed.withLock({ $0 }) { read["removedAt"] = removed ? "2026-11-21T10:00:00.000Z" : nil }
            let data = try JSONSerialization.data(withJSONObject: read)
            return String(decoding: data, as: UTF8.self)
        }

        func changeAppointment(_ appointment: String, isOn: Bool, at origin: URL?) async throws -> String {
            try await gate()
            try await Task.sleep(for: .milliseconds(400))
            removed.withLock { $0 = !isOn }
            return isOn ? #"{"result":"restored"}"# : #"{"result":"removed"}"#
        }

        // MARK: Made-up data

        /// The design data (`apps/lifelog/fixtures/design/`), one file per read, in the connector's wire shape: the
        /// simulator reads it by its path on the Mac (`-fixtureReads <folder>` reads another copy), so nothing is bundled.
        nonisolated(unsafe) private static let inboxRead = read("read_inbox")
        /// Every open ask, in the server's own order (`inboxOrderOf`); the transfer card (`dec_pay`) takes Life's outcome
        /// from `-fixtureDoneSeen`.
        nonisolated(unsafe) static let checks: [[String: Any]] = (inboxRead["checks"] as? [[String: Any]] ?? []).map {
            guard $0["ref"] as? String == "dec_pay", let state = LifeFixture.doneSeen else { return $0 }
            return $0.merging(["doneSeen": ["state": state]]) { $1 }
        }
        nonisolated(unsafe) static let rows = read("read_matters")["matters"] as? [[String: Any]] ?? []
        /// A project's page head (`read_matters` of one project): its matters are the rows that name it.
        nonisolated(unsafe) private static let projectRead = read("read_matters_project")
        nonisolated(unsafe) private static let registered = read("read_registered_agents")
        /// What only a matter's own read shows: the agents not registered (the table's, once started; Nora's, stopped) and
        /// the steps.
        nonisolated(unsafe) private static let matterRead = read("read_matter")
        nonisolated(unsafe) private static let people = read("read_people_and_organizations", or: [:])
        /// Every agent, by its matter; `-fixtureAgent` says how Nora's went.
        nonisolated(unsafe) private static let allAgents: [[String: Any]] =
            ((registered["agents"] as? [[String: Any]] ?? []) + (matterRead["agents"] as? [[String: Any]] ?? [])).map {
                agent in
                guard agent["id"] as? String == "agt_nora" else { return agent }
                var agent = agent
                if LifeFixture.agent == "notStarted" {
                    agent["status"] = "ended"
                    agent["notStarted"] = "Codex refused to start."
                }
                if LifeFixture.agent == "running" { agent["status"] = "running" }
                return agent
            }

        /// A read of the design data; `missing`, if given, stands for a file the designer has not written yet.
        private static func read(_ name: String, or missing: [String: Any]? = nil) -> [String: Any] {
            let file = URL(filePath: LifeFixture.reads).appending(path: "\(name).json")
            guard let data = try? Data(contentsOf: file),
                let object = (try? JSONSerialization.jsonObject(with: data)).map(localized) as? [String: Any]
            else {
                guard let missing else { fatalError("No design data at \(file.path)") }
                return missing
            }
            return object
        }

        private static let local = {
            let local = DateFormatter()
            local.locale = Locale(identifier: "en_US_POSIX")
            local.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
            return local
        }()

        /// An instant written without a zone ("2026-11-19T18:00:00") is the phone's own time, so "Thu 18:00" reads the
        /// same wherever it runs.
        private static func localized(_ value: Any) -> Any {
            switch value {
            case let object as [String: Any]: return object.mapValues(localized)
            case let array as [Any]: return array.map(localized)
            case let text as String:
                return local.date(from: text)?.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
                    ?? text
            default: return value
            }
        }

        /// The clips' recordings: a quiet tone of 50 s for each job a clip plays, put where `ClipAudio` finds it, so a
        /// clip plays with no lifelog behind it.
        private static func seedClipAudio() {
            let clips = checks.flatMap { $0["clips"] as? [[String: Any]] ?? [] }
            for job in Set(clips.compactMap { ($0["audio"] as? [String: Any])?["jobId"] as? String }) {
                ClipAudio.writeTone(job: job, seconds: 50)
            }
        }
    }
#endif
