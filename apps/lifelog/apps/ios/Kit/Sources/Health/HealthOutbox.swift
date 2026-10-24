import Foundation

/// Reports waiting for the server, one file each, so a crash report or a heartbeat survives a relaunch and a dead
/// connection. Its own actor: encoding, files and sends never run on the main actor or hold up capture. A failed send
/// backs off (1 min, doubling, at most 6 h); in Low Power Mode only urgent reports go.
public actor HealthOutbox {
    public enum Delivery: Sendable {
        case delivered
        /// The server refused it as malformed: retrying would not help, so it is dropped.
        case rejected
        case retry
    }

    struct Envelope: Codable {
        var path: String
        var body: Data
        var urgent: Bool
        var queuedAt: Date
        var attempts = 0
        var notBefore: Date
    }

    /// Past this the oldest reports are dropped.
    public static let limit = 100
    static let firstRetry: TimeInterval = 60
    static let maxRetry: TimeInterval = 6 * 3600

    private let directory: URL
    private var flushing = false

    public init(directory: URL) {
        self.directory = directory
    }

    /// Dates as ISO 8601, as the server parses them.
    public static func encode(_ value: some Encodable) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(value)
    }

    /// Keeps `value` until it is delivered to `path`. With `replacing`, a report still waiting under that key is
    /// rewritten in place, keeping its place and retry schedule, so repeats replace each other instead of piling up.
    public func enqueue(
        _ value: some Encodable & Sendable, path: String, urgent: Bool, replacing key: String? = nil, now: Date = .now
    ) throws {
        let url = directory.appending(path: "\(key ?? UUID().uuidString).json")
        var envelope =
            read(url) ?? Envelope(path: path, body: Data(), urgent: urgent, queuedAt: now, notBefore: now)
        envelope.body = try Self.encode(value)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try write(envelope, to: url)
        for (url, _) in pending().dropLast(Self.limit) { try? FileManager.default.removeItem(at: url) }
    }

    /// Sends what is due, oldest first, and stops at the first failure so an unreachable server isn't hammered.
    /// Returns how many reports are left.
    @discardableResult
    public func flush(
        lowPowerMode: Bool, now: Date = .now, send: @Sendable (_ path: String, _ body: Data) async -> Delivery
    ) async -> Int {
        guard !flushing else { return pending().count }
        flushing = true
        defer { flushing = false }
        for (url, sent) in pending() where sent.notBefore <= now && (sent.urgent || !lowPowerMode) {
            let delivery = await send(sent.path, sent.body)
            // A repeat may have rewritten it while it was out (`replacing`): that version still goes.
            guard var envelope = read(url) else { continue }
            switch delivery {
            case .delivered, .rejected:
                if envelope.body == sent.body { try? FileManager.default.removeItem(at: url) }
            case .retry:
                envelope.notBefore = now.addingTimeInterval(
                    min(Self.firstRetry * pow(2, Double(envelope.attempts)), Self.maxRetry))
                envelope.attempts += 1
                try? write(envelope, to: url)
                return pending().count
            }
        }
        return pending().count
    }

    /// Oldest first. An unreadable file is dropped.
    private func pending() -> [(URL, Envelope)] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return urls.compactMap { url in
            guard let envelope = read(url) else {
                try? FileManager.default.removeItem(at: url)
                return nil
            }
            return (url, envelope)
        }
        .sorted { $0.1.queuedAt < $1.1.queuedAt }
    }

    private func read(_ url: URL) -> Envelope? {
        (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(Envelope.self, from: $0) }
    }

    /// Readable in a background wake after the first unlock, like the rest of the app's support files.
    private func write(_ envelope: Envelope, to url: URL) throws {
        try JSONEncoder().encode(envelope).write(
            to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
