import Foundation
import Timeline

/// A recording imported from the old app (docs/formats.md, "Old app"). It has no Pendant pages behind it: it plays
/// from its own file.
public struct ImportedAudio: Sendable, Equatable, Codable {
    /// The old app's recording id.
    public var recordingID: String
    /// File name in `LibraryStore.importedAudio`.
    public var file: String
    /// Where the file's audio was captured, in order and disjoint.
    public var runs: [FileRun]
    /// The old app could not confirm the Pendant clock for this recording, so its time may be off.
    public var captureTimeVerified: Bool

    public init(recordingID: String, file: String, runs: [FileRun], captureTimeVerified: Bool) {
        self.recordingID = recordingID
        self.file = file
        self.runs = runs
        self.captureTimeVerified = captureTimeVerified
    }
}

/// One phone location fix. `at` is when the fix was measured, mapped to capture time; never when audio arrived.
public struct PlaceObservation: Sendable, Equatable, Codable {
    public var at: CaptureInstant
    public var latitude: Double
    public var longitude: Double
    public var accuracyMeters: Double
    /// Apple's name for the spot, asked once when the fix is taken; `nil` offline or when Apple knows none.
    public var placeName: String?

    public init(
        at: CaptureInstant, latitude: Double, longitude: Double, accuracyMeters: Double, placeName: String? = nil
    ) {
        self.at = at
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyMeters = accuracyMeters
        self.placeName = placeName
    }
}

/// A visit iOS reported: a place the owner stayed, with arrival and departure. iOS reports it on arrival, then again
/// with the same arrival once the owner leaves; either end is `nil` when iOS didn't see it.
public struct LocationVisit: Sendable, Equatable, Codable {
    public var arrival: CaptureInstant?
    public var departure: CaptureInstant?
    public var latitude: Double
    public var longitude: Double
    public var accuracyMeters: Double

    public init(
        arrival: CaptureInstant?, departure: CaptureInstant?, latitude: Double, longitude: Double,
        accuracyMeters: Double
    ) {
        self.arrival = arrival
        self.departure = departure
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyMeters = accuracyMeters
    }

    /// Its arrival, or its departure when iOS didn't see it arrive: the same for both reports of one visit.
    public var key: Int64 { (arrival ?? departure)?.millis ?? 0 }
}
