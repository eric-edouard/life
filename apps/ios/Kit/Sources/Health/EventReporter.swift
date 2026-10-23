import Foundation

/// One step the phone saw in a chain the owner relies on (catch-up held for the Mac), as the server takes it
/// (openapi `AppEvent`, `POST /events`). Ids, states and counts
/// only, never content.
public struct AppEvent: Codable, Sendable, Equatable {
    public var id = UUID()
    public var at: Date
    public var name: String
    public var fields: [String: String]
}

/// Events into their own outbox, so they can never push a crash report out of the diagnostics one. At most `limit` of
/// one name per `window`: a loop can't flood the outbox or the server.
public actor EventReporter {
    static let window: TimeInterval = 600
    static let limit = 20

    private let outbox: HealthOutbox
    private var windows: [String: (begin: Date, count: Int)] = [:]

    public init(outbox: HealthOutbox) {
        self.outbox = outbox
    }

    /// Returns whether it was kept.
    @discardableResult
    public func record(_ name: String, _ fields: [String: String], now: Date = .now) async throws -> Bool {
        var window =
            windows[name].flatMap { now.timeIntervalSince($0.begin) < Self.window ? $0 : nil } ?? (begin: now, count: 0)
        guard window.count < Self.limit else { return false }
        window.count += 1
        windows[name] = window
        try await outbox.enqueue(AppEvent(at: now, name: name, fields: fields), path: "events", urgent: false, now: now)
        return true
    }
}
