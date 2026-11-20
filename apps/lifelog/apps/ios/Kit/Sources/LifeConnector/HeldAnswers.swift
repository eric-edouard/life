import Observation

/// Answers held for a few seconds so Undo has something to undo, in the Inbox (any answer but a send or a start) and on
/// rows of Life's own questions: Life has no undo, so nothing is sent until the time is up (or the screen goes), then it
/// is an ordinary answer.
@MainActor @Observable
public final class HeldAnswers {
    public struct Held: Equatable {
        public let request: AnswerRequest
        /// The option he tapped, in its own words, for the row's slim line.
        public let label: String
    }

    public private(set) var held: [String: Held] = [:]
    /// The ref held last, if any: the one a toast names.
    public var latest: String? { order.last }
    @ObservationIgnored private var order: [String] = []
    @ObservationIgnored private var timers: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private let delay: Duration
    @ObservationIgnored private let send: @MainActor (AnswerRequest) async -> Void

    public init(delay: Duration = .seconds(4), send: @escaping @MainActor (AnswerRequest) async -> Void) {
        (self.delay, self.send) = (delay, send)
    }

    public func hold(_ request: AnswerRequest, as label: String) {
        held[request.ref] = Held(request: request, label: label)
        order.removeAll { $0 == request.ref }
        order.append(request.ref)
        timers[request.ref]?.cancel()
        timers[request.ref] = Task {
            try? await Task.sleep(for: delay)
            if !Task.isCancelled { release(request.ref) }
        }
    }

    public func undo(_ ref: String) {
        timers.removeValue(forKey: ref)?.cancel()
        held[ref] = nil
        order.removeAll { $0 == ref }
    }

    /// Every held answer now, finished when each has been answered: the screen is going, or the app.
    public func sendAll() async {
        for send in held.keys.compactMap(release) { await send.value }
    }

    /// Nothing held, nothing sent: a new pairing leaves no answer for the last Life.
    public func clear() {
        timers.values.forEach { $0.cancel() }
        (held, timers, order) = ([:], [:], [])
    }

    /// The held answer goes, in a task of its own: the timer that called is cancelled with it. It stays held until that
    /// task starts its send, in the same step, so no frame shows it neither held nor on its way, and an Undo until then
    /// still undoes it.
    @discardableResult private func release(_ ref: String) -> Task<Void, Never>? {
        timers.removeValue(forKey: ref)?.cancel()
        guard held[ref] != nil else { return nil }
        return Task {
            guard let sent = held.removeValue(forKey: ref) else { return }
            order.removeAll { $0 == ref }
            await send(sent.request)
        }
    }
}
