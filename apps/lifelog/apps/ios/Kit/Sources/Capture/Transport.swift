import Foundation
import PendantProtocol

/// The phone's Bluetooth radio as the transport sees it.
public enum BluetoothAvailability: Sendable, Equatable {
    case unknown
    case poweredOn
    case poweredOff
    case unauthorized
    case unsupported
}

public struct DiscoveredPendant: Sendable, Equatable {
    public var id: UUID
    public var name: String?

    public init(id: UUID, name: String?) {
        self.id = id
        self.name = name
    }
}

public enum DisconnectReason: Sendable, Equatable, Hashable {
    case linkLost(String?)
    case connectFailed(String?)
    case cancelled
}

/// Everything a transport reports, in order, on one stream.
public enum TransportEvent: Sendable, Equatable {
    case availability(BluetoothAvailability)
    case discovered(DiscoveredPendant)
    /// State restoration handed back this peripheral; a connect to it is (or was) pending.
    case restored(UUID)
    /// Link up; services are being discovered.
    case linkUp(UUID)
    /// Data characteristic is notifying and the control characteristic is known: commands may flow. The services found
    /// say which pendant it is.
    case ready(UUID, DeviceKind)
    /// The link needs encryption: the system pairing sheet is up, or the Pendant is bonded elsewhere.
    case pairingRequired(UUID)
    /// One raw fragment from the data characteristic.
    case notification(Data)
    /// Standard battery level characteristic, 0–100.
    case batteryLevel(Int)
    /// Device Information's firmware revision (0x2A26), read once per link. Only the Omi's is read.
    case firmwareRevision(String)
    case disconnected(UUID, DisconnectReason)
}

/// Where a write goes: the command characteristic, or the Omi's clock (`OmiGATT.timeWrite`).
public enum WriteTarget: Sendable, Equatable {
    case control
    case clock
}

public enum TransportError: Error, Sendable, Equatable {
    case notReady
    case insufficientAuthentication
    case writeFailed(String)
}

/// The seam between capture logic and the radio. `CoreBluetoothTransport` in the app,
/// `FakePendantTransport` in Debug builds and tests.
public protocol PendantTransport: Sendable {
    /// Single consumer. Finishes only when the transport is torn down.
    var events: AsyncStream<TransportEvent> { get }
    /// Starts reporting availability (and restoration). The real radio did at init; what it reported waits in `events`.
    func start() async
    func scan() async
    func stopScan() async
    /// A pending connect that never times out: it completes whenever the Pendant comes into range.
    func connect(_ id: UUID) async
    func disconnect() async
    /// Writes with response. Writes are serialized; success proves delivery, not execution.
    func write(_ bytes: Data, to target: WriteTarget) async throws(TransportError)
    /// Re-reads the standard battery level (0x2A19); the answer arrives as `.batteryLevel`. It notifies only on a
    /// change, so a steady level (a paused Pendant) would otherwise never be reported again. No-op when not ready.
    func readBattery() async
}
