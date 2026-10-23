import Foundation

/// The server's `GET /status/live` (the menu's, without the archive checks, problems and latency) or `GET /status`
/// (the status window's), as much as Voice Host shows. Each section is read on its own: a field the server adds is
/// ignored, and a section it drops or reshapes shows as unknown instead of hiding the rest.
public struct HostStatus: Decodable, Sendable {
    public struct Pipeline: Decodable, Sendable {
        public struct Transcription: Decodable, Sendable {
            public struct Waiting: Decodable, Sendable {
                public var blocks: Int
                public var seconds: Double
            }
            public struct AtProvider: Decodable, Sendable {
                public var jobs: Int
                public var oldestSentAt: Date?
            }
            public struct Fragments: Decodable, Sendable { public var seconds: Double }
            public var waiting: Waiting?
            public var atProvider: AtProvider?
            public var fragments: Fragments?
            public var failedLast24h: Int?
            public var lastTranscriptAt: Date?
        }
        public struct AI: Decodable, Sendable {
            public struct Run: Decodable, Sendable {
                public var title: String?
                public var startedAt: Date?
            }
            public var running: [Run]?
            public var waiting: Int?
            /// "macAway" or "aiOff".
            public var blockedBy: String?
            public var lastSummaryAt: Date?
        }
        public var transcription: Transcription?
        public var ai: AI?
    }
    public struct Backup: Decodable, Sendable {
        public struct Restic: Decodable, Sendable {
            public var lastSnapshotAt: Date?
            public var lastError: String?
        }
        /// Null while backups are off.
        public var restic: Restic?
    }
    public struct Mac: Decodable, Sendable {
        public struct LLM: Decodable, Sendable {
            public var able: Bool?
            public var reason: String?
        }
        public var connected: Bool?
        public var state: String?
        public var heardAt: Date?
        public var llm: LLM?
    }
    public struct Pendant: Decodable, Sendable {
        /// "charging" or "unverified" (older phones sent true or false).
        public struct Charging: Decodable, Sendable {
            public var on: Bool
            public init(from decoder: Decoder) throws {
                let value = try decoder.singleValueContainer()
                on = try (try? value.decode(Bool.self)) ?? (value.decode(String.self) == "charging")
            }
        }
        public var batteryPercent: Int?
        public var charging: Charging?
        public var connection: String?
        public var recording: String?
        public var knownAt: Date?
    }
    public struct Heartbeat: Decodable, Sendable { public var receivedAt: Date? }
    public struct Transcription: Decodable, Sendable {
        public struct Quota: Decodable, Sendable {
            public var limit: Double
            public var used: Double
            public var checkedAt: Date?
        }
        public struct Latency: Decodable, Sendable {
            public struct Spread: Decodable, Sendable {
                public var median: Double?
                public var p90: Double?
            }
            public var transcriptionSeconds: Spread?
        }
        public var quota: Quota?
        public var latency: Latency?
    }
    /// Speaker recognition: whether the server has IDENTITY_URL, and how the service last answered.
    public struct Identity: Decodable, Sendable {
        public var configured: Bool
        public var lastOkAt: Date?
        public var lastError: String?
    }
    public struct Switches: Decodable, Sendable {
        public var ai: Bool?
        public var transcription: Bool?
        public var engine: String?
    }

    public var pipeline: Pipeline?
    public var backup: Backup?
    public var mac: Mac?
    public var pendant: Pendant?
    public var phoneHeartbeat: Heartbeat?
    public var transcription: Transcription?
    public var identity: Identity?
    public var switches: Switches?
    public var problemsLast24h: [String: Int]?
    /// The archive's invariants, each 0 when all is well.
    public var archive: [String: Int]?

    private enum Key: String, CodingKey {
        case pipeline, backup, mac, pendant, phoneHeartbeat, transcription, identity, switches, problemsLast24h,
            archive
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        func section<T: Decodable>(_ key: Key) -> T? { try? c.decodeIfPresent(T.self, forKey: key) }
        pipeline = section(.pipeline)
        backup = section(.backup)
        mac = section(.mac)
        pendant = section(.pendant)
        phoneHeartbeat = section(.phoneHeartbeat)
        transcription = section(.transcription)
        identity = section(.identity)
        switches = section(.switches)
        problemsLast24h = section(.problemsLast24h)
        archive = section(.archive)
    }

    /// The server's JSON (ISO 8601 times, with or without milliseconds), or nil when it isn't an object.
    public static func decode(_ data: Data) -> HostStatus? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            for style in [Date.ISO8601FormatStyle(includingFractionalSeconds: true), Date.ISO8601FormatStyle()] {
                if let date = try? Date(text, strategy: style) { return date }
            }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: text))
        }
        return try? decoder.decode(HostStatus.self, from: data)
    }
}

extension Host {
    public struct Row: Equatable, Sendable, Identifiable {
        public var label: String
        public var value: String
        public var trouble: Bool
        public var id: String { label }
        init(_ label: String, _ value: String, trouble: Bool = false) {
            self.label = label
            self.value = value
            self.trouble = trouble
        }
    }

    /// One part of the pipeline: its line in the menu (`summary`) and its rows in the status window.
    public struct Section: Equatable, Sendable, Identifiable {
        public var summary: Row
        public var details: [Row]
        /// Shown in the menu even when nothing is wrong with it.
        public var inMenu: Bool
        public var id: String { summary.label }
    }

    /// "Voice Host: all good", or how many sections are in trouble.
    public static func verdict(_ sections: [Section]) -> String {
        let troubled = sections.count(where: \.summary.trouble)
        return troubled == 0 ? "Voice Host: all good" : "Voice Host: \(troubled) to look at"
    }

    /// What the status says, section by section, as of `now`; nil (the server didn't answer) is one section in trouble.
    public static func report(_ status: HostStatus?, now: Date) -> [Section] {
        guard let status else {
            return [Section(summary: Row("Server", "not answering", trouble: true), details: [], inMenu: true)]
        }
        let ago = { (date: Date?) in Self.ago(date, now: now) }
        let unknown = "unknown"
        var sections: [Section] = []

        let transcription = status.pipeline?.transcription
        let paused = status.switches?.transcription == false
        let waiting = transcription?.waiting
        let failed = transcription?.failedLast24h ?? 0
        let waitingText = waiting.map { $0.blocks == 0 ? "nothing" : "\($0.blocks) blocks · \(duration($0.seconds))" }
        let latency = status.transcription?.latency?.transcriptionSeconds
        sections.append(
            Section(
                summary: Row(
                    "To transcribe", paused ? "paused: transcription is off" : waitingText ?? unknown,
                    trouble: failed > 0 || (paused && (waiting?.blocks ?? 0) > 0)),
                details: [
                    Row("Blocks waiting", waitingText ?? unknown),
                    Row("Fragments waiting", transcription?.fragments.map { duration($0.seconds) } ?? unknown),
                    Row(
                        "Failed in the last day", transcription?.failedLast24h.map(String.init) ?? unknown,
                        trouble: failed > 0),
                    Row("Last transcript", ago(transcription?.lastTranscriptAt)),
                    Row(
                        "Time to transcribe (median, 90%)",
                        latency.map { "\(seconds($0.median)), \(seconds($0.p90))" } ?? unknown),
                ],
                inMenu: true))

        let provider = transcription?.atProvider
        let stale = provider?.oldestSentAt.map { now.timeIntervalSince($0) > 2 * 3600 } ?? false
        let providerText = provider.map { $0.jobs == 0 ? "nothing" : "\($0.jobs) jobs, since \(ago($0.oldestSentAt))" }
        sections.append(
            Section(
                summary: Row("At ElevenLabs", providerText ?? unknown, trouble: stale),
                details: [
                    Row("Jobs sent, not back", provider.map { String($0.jobs) } ?? unknown),
                    Row("Oldest sent", ago(provider?.oldestSentAt), trouble: stale),
                ],
                inMenu: true))

        let ai = status.pipeline?.ai
        let running = ai?.running ?? []
        let blocked = ai?.blockedBy.map { $0 == "aiOff" ? "AI is off" : $0 == "macAway" ? "the Mac is away" : $0 }
        let aiWaiting = ai?.waiting ?? 0
        let aiParts =
            (running.isEmpty
                ? []
                : [running.count == 1 ? "summarizing “\(running[0].title ?? "untitled")”" : "\(running.count) running"])
            + (aiWaiting > 0 ? ["\(aiWaiting) waiting"] : []) + (blocked.map { ["blocked: \($0)"] } ?? [])
        sections.append(
            Section(
                summary: Row(
                    "AI", ai == nil ? unknown : aiParts.isEmpty ? "idle" : aiParts.joined(separator: " · "),
                    trouble: blocked != nil && aiWaiting > 0),
                details: running.map { Row("Summarizing “\($0.title ?? "untitled")”", "started \(ago($0.startedAt))") }
                    + [
                        Row("Waiting", ai?.waiting.map(String.init) ?? unknown),
                        Row("Blocked by", blocked ?? "nothing", trouble: blocked != nil && aiWaiting > 0),
                        Row("Last summary", ago(ai?.lastSummaryAt)),
                        Row("Engine", status.switches?.engine ?? unknown),
                    ],
                inMenu: true))

        let pendant = status.pendant
        let battery = pendant?.batteryPercent.map { "\($0)%\(pendant?.charging?.on == true ? " charging" : "")" }
        let low = (pendant?.batteryPercent ?? 100) < 15 && pendant?.charging?.on != true
        // Only a Pendant that isn't recording: `listening` is recording on, `unknown` a brief reconnect.
        let notRecording = ["paused", "not_recording", "failed"].contains(pendant?.recording)
        sections.append(
            Section(
                summary: Row(
                    "Pendant",
                    pendant.map { p in
                        [battery, p.recording?.replacingOccurrences(of: "_", with: " "), "seen \(ago(p.knownAt))"]
                            .compactMap { $0 }.joined(separator: " · ")
                    } ?? "not seen yet",
                    trouble: notRecording || low),
                details: [
                    Row("Battery", battery ?? unknown, trouble: low),
                    Row("Recording", pendant?.recording ?? unknown, trouble: notRecording),
                    Row("Connection", pendant?.connection ?? unknown),
                    Row("Last known", ago(pendant?.knownAt)),
                ],
                inMenu: true))

        let beat = status.phoneHeartbeat?.receivedAt
        let quiet = beat.map { now.timeIntervalSince($0) > 12 * 3600 } ?? false
        sections.append(
            Section(
                summary: Row("Phone", beat == nil ? "not paired yet" : "heard \(ago(beat))", trouble: quiet),
                details: [Row("Last heartbeat", ago(beat), trouble: quiet)], inMenu: true))

        let mac = status.mac
        let unable = mac?.llm?.able == false
        let macTrouble = mac?.connected != true || unable
        sections.append(
            Section(
                summary: Row(
                    "Mac helper",
                    (mac?.state ?? "never heard")
                        + (unable ? " · summaries can't run\(mac?.llm?.reason.map { " (\($0))" } ?? "")" : ""),
                    trouble: macTrouble),
                details: [
                    Row("State", mac?.state ?? "never heard", trouble: mac?.connected != true),
                    Row("Last heard", ago(mac?.heardAt)),
                    Row(
                        "Summaries", unable ? "can't run\(mac?.llm?.reason.map { ": \($0)" } ?? "")" : "can run",
                        trouble: unable
                    ),
                ],
                inMenu: true))

        // Off, voices aren't named: always in the menu, so it can't go unnoticed again.
        let identity = status.identity
        let identityText: String =
            if let identity {
                !identity.configured
                    ? "off"
                    : identity.lastError.map { "failing: \($0)" }
                        ?? identity.lastOkAt.map { "on, last used \(ago($0))" } ?? "on, not used yet"
            } else { unknown }
        sections.append(
            Section(
                summary: Row("Speaker recognition", identityText, trouble: identity?.lastError != nil),
                details: [
                    Row("Set up", identity.map { $0.configured ? "yes" : "no: voices aren't named" } ?? unknown),
                    Row("Last answer", ago(identity?.lastOkAt)),
                    Row("Last error", identity?.lastError ?? "none", trouble: identity?.lastError != nil),
                ],
                inMenu: true))

        let quota = status.transcription?.quota
        let left = quota.map { $0.limit > 0 ? Int(((1 - $0.used / $0.limit) * 100).rounded()) : 0 }
        sections.append(
            Section(
                summary: Row("ElevenLabs credits", left.map { "\($0)% left" } ?? unknown, trouble: (left ?? 100) < 20),
                details: [
                    Row("Used", quota.map { "\(Int($0.used)) of \(Int($0.limit))" } ?? unknown),
                    Row("Checked", ago(quota?.checkedAt)),
                ],
                inMenu: true))

        let restic = status.backup?.restic
        let old = restic?.lastSnapshotAt.map { now.timeIntervalSince($0) > 48 * 3600 } ?? false
        let backupText: String =
            if let restic {
                restic.lastError.map { "failed: \($0)" } ?? restic.lastSnapshotAt.map { "last \(ago($0))" } ?? "not yet"
            } else { "off" }
        sections.append(
            Section(
                summary: Row("Backup", backupText, trouble: restic?.lastError != nil || old),
                details: [
                    Row("Last snapshot", restic == nil ? "off" : ago(restic?.lastSnapshotAt), trouble: old),
                    Row("Last error", restic?.lastError ?? "none", trouble: restic?.lastError != nil),
                ],
                inMenu: true))

        let problems = (status.problemsLast24h ?? [:]).sorted { $0.key < $1.key }
        let problemCount = problems.reduce(0) { $0 + $1.value }
        sections.append(
            Section(
                summary: Row(
                    "Problems in the last day",
                    status.problemsLast24h == nil ? unknown : problemCount == 0 ? "none" : String(problemCount),
                    trouble: problemCount > 0),
                details: problems.map { Row($0.key, String($0.value), trouble: $0.value > 0) },
                inMenu: false))

        let invariants = (status.archive ?? [:]).sorted { $0.key < $1.key }
        let broken = invariants.count { $0.value != 0 }
        sections.append(
            Section(
                summary: Row(
                    "Archive",
                    status.archive == nil ? unknown : broken == 0 ? "consistent" : "\(broken) checks off",
                    trouble: broken > 0),
                details: invariants.map { Row($0.key, String($0.value), trouble: $0.value != 0) },
                inMenu: false))
        return sections
    }

    /// "just now", "5 min ago", "3 h ago", "2 d ago"; "never" without a time.
    public static func ago(_ date: Date?, now: Date) -> String {
        guard let date else { return "never" }
        let minutes = Int(now.timeIntervalSince(date) / 60)
        return switch minutes {
        case ..<1: "just now"
        case ..<60: "\(minutes) min ago"
        case ..<(48 * 60): "\(minutes / 60) h ago"
        default: "\(minutes / 1440) d ago"
        }
    }

    /// Audio length: "45 s", "12 min", "2 h 05".
    static func duration(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        return switch total {
        case ..<60: "\(total) s"
        case ..<3600: "\(total / 60) min"
        default: "\(total / 3600) h \(String(format: "%02d", total % 3600 / 60))"
        }
    }

    private static func seconds(_ value: Double?) -> String { value.map { "\(Int($0.rounded())) s" } ?? "unknown" }
}
