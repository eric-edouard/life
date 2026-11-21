import Foundation
import Observation

/// Which pairing with Life the phone is in: each new pairing is the next generation, and work begun in an older one (a
/// read, a picture batch) applies nothing to the new Life, not even its failure. Observed, so a screen's reads start
/// again on a new pairing, the same Life's too.
@MainActor @Observable
public final class PairingGeneration {
    public private(set) var current = 0

    public init() {}

    /// Another Life is paired.
    public func next() { current += 1 }

    /// `fetch`'s answer or failure, or nil when another pairing began while it ran.
    public func answer(_ fetch: () async throws -> String) async -> Result<String, any Error>? {
        let began = current
        let answer: Result<String, any Error>
        do { answer = .success(try await fetch()) } catch { answer = .failure(error) }
        return began == current ? answer : nil
    }
}

/// The Life an answer was decided for, captured once at his tap (on a card, a notification's button or Send, or when he
/// held it for Undo): every attempt of it goes to that origin with that Life's bearer (`MCPClient.call(at:)`), and only
/// while its pairing's generation is still the current one. Never read again later: a retry, a queued release or a late
/// send carries it as it was.
public struct PairedLife: Sendable, Equatable {
    public let origin: URL
    public let generation: Int

    public init(origin: URL, generation: Int) {
        (self.origin, self.generation) = (origin, generation)
    }
}
