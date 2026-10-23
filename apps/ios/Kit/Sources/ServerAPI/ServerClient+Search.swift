import Foundation
import Library
import Timeline

extension ServerClient {
    // MARK: Search

    /// Passages the server finds by meaning (and by the words typed), best first. The query goes to OpenAI to be
    /// embedded (docs/providers.md).
    public func search(_ query: String, limit: Int = 20) async throws -> [MeaningHit] {
        struct Body: Encodable {
            var query: String
            var limit: Int
        }
        struct Hit: Decodable {
            var conversationId: UUID
            var capturedFrom: Date?
            var capturedTo: Date?
            var text: String
        }
        struct Hits: Decodable { var hits: [Hit] }
        return try decode(Hits.self, try await send("search", method: "POST", Body(query: query, limit: limit))).hits
            .map { hit in
                let passage = hit.capturedFrom.flatMap { from in
                    hit.capturedTo.map { CaptureInstant(from)..<max(CaptureInstant(from), CaptureInstant($0)) }
                }
                return MeaningHit(conversation: hit.conversationId, passage: passage, text: hit.text)
            }
    }
}
