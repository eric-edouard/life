extension ServerClient {
    /// Timeline spans and how far the phone has heard (`FactsBuilder`). A span replaces the one with its first page.
    public func putTimeline(source: String, _ timeline: some Encodable & Sendable) async throws {
        _ = try await send("sources/\(source)/timeline", method: "PUT", timeline)
    }
}
