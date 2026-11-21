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
        /// The Life it was decided for, at his tap: it is sent there or not at all.
        public let life: PairedLife?
    }

    public private(set) var held: [String: Held] = [:]
    /// The ref held last, if any: the one a toast names.
    public var latest: String? { order.last }
    @ObservationIgnored private var order: [String] = []
    @ObservationIgnored private var timers: [String: Task<Void, Never>] = [:]
    /// Each released answer's send, by its release, until it ended: what still hides its card, and what every flush
    /// waits for.
    private var sending: [Int: (ref: String, going: Task<Void, Never>)] = [:]
    @ObservationIgnored private var releases = 0
    /// Held or being sent: answers whose card no read may bring back yet.
    public var underWay: Set<String> { Set(held.keys).union(sending.values.map(\.ref)) }
    @ObservationIgnored private let delay: Duration
    @ObservationIgnored private let send: @MainActor (Held) async -> Void

    public init(delay: Duration = .seconds(4), send: @escaping @MainActor (Held) async -> Void) {
        (self.delay, self.send) = (delay, send)
    }

    /// His answer, held for Undo, for the Life he gave it to (`life`, captured at his tap).
    public func hold(_ request: AnswerRequest, as label: String, for life: PairedLife? = nil) {
        held[request.ref] = Held(request: request, label: label, life: life)
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

    /// Every held answer now, finished when every send under way has ended: the screen is going, or the app.
    public func sendAll() async {
        Array(held.keys).forEach(release)
        for going in sending.values.map(\.going) { await going.value }
    }

    /// Nothing held, nothing sent: a new pairing leaves no answer for the last Life. A released answer still waiting
    /// behind another never starts; one being sent is cancelled (it went to its own Life, if anywhere).
    public func clear() {
        timers.values.forEach { $0.cancel() }
        sending.values.forEach { $0.going.cancel() }
        (held, timers, order) = ([:], [:], [])
    }

    /// The one release of a held answer, from its timer or a flush: in the same step it leaves `held` for `sending`, so
    /// no frame shows it neither, and it goes after any earlier send of the same ref has ended. Its own task: the timer
    /// that called is cancelled with it.
    private func release(_ ref: String) {
        timers.removeValue(forKey: ref)?.cancel()
        guard let sent = held.removeValue(forKey: ref) else { return }
        order.removeAll { $0 == ref }
        let earlier = sending.values.filter { $0.ref == ref }.map(\.going)
        let number = releases
        releases += 1
        // Set before the task runs: it starts on this actor, after this step.
        sending[number] = (
            ref,
            Task {
                for task in earlier { await task.value }
                if !Task.isCancelled { await send(sent) }
                sending[number] = nil
            }
        )
    }
}

extension ActionState where Proof == ActionProof {
    /// What a held answer's end says back on its own, its card gone by then: that Life recorded it but did not end its
    /// step as asked, and Life's reason; or the day a Not now brings its card back. Nil: nothing to say.
    public var heldAnswerWords: String? {
        guard case .succeeded(.answered(let result), _) = self, let changed = result.changed else { return nil }
        return changed.ended?.error.map { "Your answer was recorded. \($0)" } ?? changed.snoozed()
    }
}
