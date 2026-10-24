import Foundation

public enum ConnectionState: Sendable, Equatable {
    /// Not started, or Bluetooth state not yet known.
    case idle
    case bluetoothOff
    case unauthorized
    case unsupported
    case scanning
    /// Pending connect to a known Pendant. Never times out.
    case connecting(UUID)
    /// Link up, services not ready yet.
    case discovering(UUID)
    /// The link needs bonding: the system pairing sheet, or a bond held by another phone.
    case pairingPending(UUID)
    case ready(UUID)
    /// Connected but the Pendant ignores us, most likely because another app holds it. We let go of the link
    /// so we don't starve that app, and wait for the owner to retry.
    case busyElsewhere(UUID)
    /// Link lost; a pending reconnect is open.
    case disconnected(UUID, DisconnectReason)
    /// Let go between drains, with no pending connect: an Omi drops its audio while a phone is connected
    /// (`DeviceKind.holdsLink`). The next sync connects again.
    case resting(UUID)
}

public enum ConnectionEvent: Sendable, Equatable {
    case start(knownDevice: UUID?)
    /// The owner asked to find a Pendant (setup or retry). Only this may start a scan: launching never does,
    /// so a new install can never take the Pendant from another app on its own.
    case discover
    case availability(BluetoothAvailability)
    case discovered(DiscoveredPendant)
    case restored(UUID)
    case linkUp(UUID)
    case ready(UUID)
    case pairingRequired(UUID)
    /// The handshake status query got no reply at all.
    case unresponsive(UUID)
    /// The app stopped handling the Pendant's messages on a live link (`DrainCoordinator.watchStall`).
    case stalled(UUID)
    /// A drain settled on a pendant that must not stay connected.
    case release(UUID)
    case disconnected(UUID, DisconnectReason)
}

public enum ConnectionEffect: Sendable, Equatable {
    case scan
    case stopScan
    case connect(UUID)
    case disconnect
    /// A new connection is ready. Its generation fences every task that belongs to it.
    case sessionStarted(UUID, generation: UInt64)
    case sessionEnded(generation: UInt64)
}

/// Pure connection state machine: `handle(event)` returns the effects to perform, in order.
public struct ConnectionMachine: Sendable {
    public private(set) var state: ConnectionState = .idle
    public private(set) var device: UUID?
    public private(set) var generation: UInt64 = 0
    private var started = false
    private var discoveryAllowed = false
    private var availability: BluetoothAvailability = .unknown

    public init() {}

    public mutating func handle(_ event: ConnectionEvent) -> [ConnectionEffect] {
        switch event {
        case .start(let known):
            started = true
            device = known ?? device
            return resume()
        case .discover:
            started = true
            discoveryAllowed = true
            return resume()
        case .availability(let new):
            guard new != availability else { return [] }
            availability = new
            let ended = endSession()
            switch new {
            case .poweredOn: return ended + resume()
            case .poweredOff: state = .bluetoothOff
            case .unauthorized: state = .unauthorized
            case .unsupported: state = .unsupported
            case .unknown: state = .idle
            }
            return ended
        case .discovered(let pendant):
            // ponytail: auto-picks the first Pendant seen.
            guard state == .scanning else { return [] }
            device = pendant.id
            state = .connecting(pendant.id)
            return [.stopScan, .connect(pendant.id)]
        case .restored(let id):
            device = id
            if state == .idle { state = .connecting(id) }
            return []
        case .linkUp(let id):
            guard id == device else { return [] }
            state = .discovering(id)
            return []
        case .ready(let id):
            guard id == device else { return [] }
            generation += 1
            state = .ready(id)
            return [.sessionStarted(id, generation: generation)]
        case .pairingRequired(let id):
            guard id == device else { return [] }
            let ended = endSession()
            state = .pairingPending(id)
            return ended
        case .unresponsive(let id):
            guard id == device else { return [] }
            let ended = endSession()
            state = .busyElsewhere(id)
            return ended + [.disconnect]
        case .stalled(let id):
            guard id == device, case .ready = state else { return [] }
            let ended = endSession()
            state = .connecting(id)
            // The disconnect it causes reconnects (`.disconnected`).
            return ended + [.disconnect]
        case .release(let id):
            guard id == device, case .ready = state else { return [] }
            let ended = endSession()
            state = .resting(id)
            return ended + [.disconnect]
        case .disconnected(let id, let reason):
            guard id == device else { return [] }
            let ended = endSession()
            switch state {
            case .busyElsewhere, .resting: return ended
            default: break
            }
            guard availability == .poweredOn else { return ended }
            state = .disconnected(id, reason)
            return ended + [.connect(id)]
        }
    }

    private mutating func resume() -> [ConnectionEffect] {
        guard started, availability == .poweredOn else { return [] }
        if case .ready = state { return [] }
        if let device {
            // A known Pendant is a pending connect, never a scan: it completes whenever it comes back in range.
            let stop: [ConnectionEffect] = state == .scanning ? [.stopScan] : []
            state = .connecting(device)
            return stop + [.connect(device)]
        }
        guard discoveryAllowed else {
            state = .idle
            return []
        }
        state = .scanning
        return [.scan]
    }

    private func endSession() -> [ConnectionEffect] {
        if case .ready = state { return [.sessionEnded(generation: generation)] }
        return []
    }
}
