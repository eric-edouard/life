import Foundation
import Library
import Timeline

extension ServerClient {
    // MARK: Location history

    /// Fixes and visits for the server's whole location history, at most 1000 of each, each fix with Apple's name for
    /// it when there is one (the server labels conversations from them). Idempotent: the server keeps one fix per
    /// instant and replaces a visit sent again with its departure.
    public func addLocationHistory(fixes: [PlaceObservation], visits: [LocationVisit]) async throws {
        struct Fix: Encodable {
            var observedAt: Date
            var latitude: Double
            var longitude: Double
            var accuracyM: Double
            var placeName: String?
        }
        struct Visit: Encodable {
            var arrivedAt: Date?
            var departedAt: Date?
            var latitude: Double
            var longitude: Double
            var accuracyM: Double
            enum CodingKeys: CodingKey { case arrivedAt, departedAt, latitude, longitude, accuracyM }
            // `null`, not absent, for an end iOS didn't see.
            func encode(to encoder: any Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(arrivedAt, forKey: .arrivedAt)
                try container.encode(departedAt, forKey: .departedAt)
                try container.encode(latitude, forKey: .latitude)
                try container.encode(longitude, forKey: .longitude)
                try container.encode(accuracyM, forKey: .accuracyM)
            }
        }
        struct Body: Encodable {
            var fixes: [Fix]
            var visits: [Visit]
        }
        _ = try await send(
            "location-history", method: "POST",
            Body(
                fixes: fixes.map {
                    Fix(
                        observedAt: Self.date($0.at), latitude: $0.latitude, longitude: $0.longitude,
                        accuracyM: $0.accuracyMeters, placeName: $0.placeName)
                },
                visits: visits.map {
                    Visit(
                        arrivedAt: $0.arrival.map(Self.date), departedAt: $0.departure.map(Self.date),
                        latitude: $0.latitude, longitude: $0.longitude, accuracyM: $0.accuracyMeters)
                }))
    }
}
