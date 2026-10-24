import CoreLocation
import Library
import MapKit
import Timeline

/// Records where the phone is, sparingly: one fix every five minutes while the app runs and the Pendant isn't known
/// to be paused, each with its own measurement time and accuracy, and the visits iOS reports. Bluetooth keeps the app
/// running in the background while the Pendant is near, so with Always the fixes cover the day, not only the minutes
/// the app is open; visits cover the rest. Processing pairs fixes with conversations by those times only, and sends
/// both to the server's location history. Denied, approximate or missing location just records nothing.
final class LocationRecorder {
    /// ponytail: one short fix per tick, never continuous GPS. Visits come free; tighten fixes only if they don't do.
    nonisolated static let interval: Duration = .seconds(300)
    nonisolated static let maxAccuracyMeters: Double = 100

    private var task: Task<Void, Never>?
    /// Held for the app's life: without it Always gives no fixes while the app isn't in use.
    private var session: CLServiceSession?
    private var visits: VisitMonitor?

    /// Asks for Always the first time it's called while the app is open (iOS offers While Using first, then the
    /// upgrade once) and holds it after that. Called once a Pendant is paired: at launch, which retakes it at once
    /// after a background relaunch as Core Location requires, and whenever the app comes forward.
    func claim() {
        session = session ?? CLServiceSession(authorization: .always)
    }

    func start(paused: @escaping () -> Bool, record: @escaping (PlaceObservation) async -> Void) {
        guard task == nil else { return }
        task = Task {
            let manager = CLLocationManager()
            while !Task.isCancelled {
                if !paused(), [.authorizedWhenInUse, .authorizedAlways].contains(manager.authorizationStatus),
                    var fix = await Self.oneFix()
                {
                    fix.placeName = await Self.placeName(latitude: fix.latitude, longitude: fix.longitude)
                    await record(fix)
                }
                try? await Task.sleep(for: Self.interval)
            }
        }
    }

    /// Asks iOS for visits: arrival and departure at places the owner stays. iOS finds them from signals it already
    /// has (Wi-Fi, cell, motion), so they cost no GPS, and it relaunches the app to report one: they cover hours the
    /// app isn't running. Called at every launch, which a visit's relaunch needs. Needs Always; nothing comes without.
    func monitorVisits(record: @escaping (LocationVisit) async -> Void) {
        visits = visits ?? VisitMonitor(record: record)
    }

    /// Apple's short name for a spot ("Oakridge 21"), in English, sent with the fix for the server to label
    /// conversations; `nil` offline or when Apple knows none. A network lookup Apple throttles to about one a second,
    /// asked once per fix.
    @concurrent static func placeName(latitude: Double, longitude: Double) async -> String? {
        guard let request = MKReverseGeocodingRequest(location: CLLocation(latitude: latitude, longitude: longitude))
        else { return nil }
        request.preferredLocale = Locale(identifier: "en")
        guard let item = try? await request.mapItems.first else { return nil }
        return item.address?.shortAddress ?? item.addressRepresentations?.cityWithContext
    }

    /// The first fix good to `maxAccuracyMeters`, or nothing within 30 s.
    @concurrent static func oneFix() async -> PlaceObservation? {
        await withTaskGroup(of: PlaceObservation?.self) { group in
            group.addTask {
                do {
                    for try await update in CLLocationUpdate.liveUpdates() {
                        if update.authorizationDenied || update.authorizationDeniedGlobally { return nil }
                        guard let location = update.location, location.horizontalAccuracy >= 0,
                            location.horizontalAccuracy <= maxAccuracyMeters
                        else { continue }
                        return PlaceObservation(
                            at: CaptureInstant(millis: Int64(location.timestamp.timeIntervalSince1970 * 1000)),
                            latitude: location.coordinate.latitude, longitude: location.coordinate.longitude,
                            accuracyMeters: location.horizontalAccuracy)
                    }
                } catch {}
                return nil
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(30))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }
}

/// Core Location's visit callbacks, on the main thread that created the manager.
private final class VisitMonitor: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let record: (LocationVisit) async -> Void

    init(record: @escaping (LocationVisit) async -> Void) {
        self.record = record
        super.init()
        manager.delegate = self
        manager.startMonitoringVisits()
    }

    /// iOS marks an end it didn't see with a distant date: kept as `nil`.
    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        let instant = { (date: Date) -> CaptureInstant? in
            date == .distantPast || date == .distantFuture
                ? nil : CaptureInstant(millis: Int64(date.timeIntervalSince1970 * 1000))
        }
        let (arrival, departure) = (instant(visit.arrivalDate), instant(visit.departureDate))
        guard visit.horizontalAccuracy >= 0, arrival != nil || departure != nil else { return }
        let found = LocationVisit(
            arrival: arrival, departure: departure, latitude: visit.coordinate.latitude,
            longitude: visit.coordinate.longitude, accuracyMeters: visit.horizontalAccuracy)
        Task { @MainActor in await record(found) }
    }
}
