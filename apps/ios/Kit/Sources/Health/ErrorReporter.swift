import Foundation

/// Errors the owner saw, into the outbox as `app_error` diagnostics. Repeats of one error (same place, type and code)
/// within an hour are one report whose count rises: rewritten in place while it waits, and sent again under the same
/// id once delivered, which the server takes as a replacement. An offline loop can't push crashes out of the outbox.
public actor ErrorReporter {
    static let window: TimeInterval = 3600

    private struct Window {
        var id = UUID()
        var begin: Date
        var count = 0
    }

    private let outbox: HealthOutbox
    private let build: BuildInfo
    private var windows: [String: Window] = [:]

    public init(outbox: HealthOutbox, build: BuildInfo) {
        self.outbox = outbox
        self.build = build
    }

    /// Returns whether it is the first of its window, worth sending at once; repeats go with the next flush.
    @discardableResult
    public func record(_ error: DiagnosticUpload.AppError, returnAddresses: [UInt], now: Date = .now) async throws
        -> Bool
    {
        var window =
            windows[error.key].flatMap { now.timeIntervalSince($0.begin) < Self.window ? $0 : nil }
            ?? Window(begin: now)
        window.count += 1
        windows[error.key] = window
        var error = error
        error.count = window.count
        var upload = DiagnosticUpload(
            error, returnAddresses: returnAddresses, build: build, begin: window.begin, end: now)
        upload.id = window.id
        try await outbox.enqueue(
            upload, path: "diagnostics", urgent: false, replacing: window.id.uuidString, now: now)
        return window.count == 1
    }
}
