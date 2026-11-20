import Foundation

/// Which pairing with Life the phone is in: each new pairing is the next generation, and work begun in an older one (a
/// read, a picture batch) applies nothing to the new Life, not even its failure.
@MainActor
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
