import Foundation

extension ServerClient {
    /// At most 1000 measurements; Health is the durable store, so a failed chunk is read again.
    public func addAppleHealth(_ measurements: [AppleHealthMeasurement]) async throws {
        struct Body: Encodable { let measurements: [AppleHealthMeasurement] }
        _ = try await send("apple-health", method: "POST", Body(measurements: measurements))
    }
}
