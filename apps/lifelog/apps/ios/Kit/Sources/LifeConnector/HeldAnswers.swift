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
    /// The tap that held each ref with others (a bulk ask's): Undo of one is Undo of all, one timer releases them.
    @ObservationIgnored private var together: [String: Int] = [:]
    @ObservationIgnored private var taps = 0
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
        put(request, as: label, for: life)
        timers[request.ref] = Task {
            try? await Task.sleep(for: delay)
            if !Task.isCancelled { release(request.ref) }
        }
    }

    /// His answers to many asks by one tap, held as one: one toast (`label`), one timer, one Undo.
    public func hold(_ requests: [AnswerRequest], as label: String, for life: PairedLife? = nil) {
        taps += 1
        let tap = taps
        for request in requests {
            put(request, as: label, for: life)
            together[request.ref] = tap
        }
        let timer = Task {
            try? await Task.sleep(for: delay)
            if !Task.isCancelled { members(of: tap).forEach(release) }
        }
        requests.forEach { timers[$0.ref] = timer }
    }

    /// Undo of `ref`, and of every answer still held with it by the same tap.
    public func undo(_ ref: String) {
        let refs = together[ref].map { members(of: $0) } ?? [ref]
        for ref in refs {
            timers.removeValue(forKey: ref)?.cancel()
            held[ref] = nil
            together[ref] = nil
            order.removeAll { $0 == ref }
        }
    }

    /// `request` held as the latest; held again alone, it leaves its tap (whose timer goes on for the others).
    private func put(_ request: AnswerRequest, as label: String, for life: PairedLife?) {
        held[request.ref] = Held(request: request, label: label, life: life)
        order.removeAll { $0 == request.ref }
        order.append(request.ref)
        if together.removeValue(forKey: request.ref) != nil {
            timers[request.ref] = nil
        } else {
            timers[request.ref]?.cancel()
        }
    }

    private func members(of tap: Int) -> [String] { order.filter { together[$0] == tap } }

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
        (held, timers, order, together) = ([:], [:], [], [:])
    }

    /// The one release of a held answer, from its timer or a flush: in the same step it leaves `held` for `sending`, so
    /// no frame shows it neither, and it goes after any earlier send of the same ref has ended. Its own task: the timer
    /// that called is cancelled with it.
    private func release(_ ref: String) {
        timers.removeValue(forKey: ref)?.cancel()
        guard let sent = held.removeValue(forKey: ref) else { return }
        order.removeAll { $0 == ref }
        together[ref] = nil
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
    /// step as asked, and Life's reason (`isDone` false); or the day a Not now brings its card back. Nil: nothing to say.
    public var heldAnswerWords: (words: String, isDone: Bool)? {
        guard case .succeeded(.answered(let result), _) = self, let changed = result.changed else { return nil }
        if let error = changed.ended?.error { return ("Your answer was recorded. \(error)", false) }
        return changed.snoozed().map { ($0, true) }
    }
}
