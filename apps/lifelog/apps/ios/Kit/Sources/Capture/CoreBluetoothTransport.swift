// CoreBluetooth isn't annotated for Sendable. Safety invariant: the central is created in `init` with `queue` held
// suspended; after that every CB object is called back and used only on `queue`, which is this actor's executor;
// `assumeIsolated` traps if a callback ever arrives elsewhere.
// Drop `@preconcurrency` once the SDK marks CBPeripheral and friends.
@preconcurrency import CoreBluetooth
import Foundation
import PendantProtocol

/// The real radio. An actor whose executor *is* the CoreBluetooth delegate queue, so every delegate callback runs
/// isolated to it (`assumeIsolated`) and all CB objects stay confined to one serial queue. No other GCD is used.
///
/// Background behaviour: the central has a restore identifier and is created in `init`, so building the transport
/// during launch is what Apple asks for. `willRestoreState` re-adopts the peripheral, and a pending `connect` (which
/// never times out) is always kept open so iOS relaunches us when the Pendant returns. Events from before `start()`
/// (availability, restoration) wait in `events` until the drain reads them.
public actor CoreBluetoothTransport: PendantTransport {
    private let serviceUUID = CBUUID(string: PendantGATT.service)
    private let controlUUID = CBUUID(string: PendantGATT.control)
    private let dataUUID = CBUUID(string: PendantGATT.data)
    private let batteryServiceUUID = CBUUID(string: PendantGATT.batteryService)
    private let batteryLevelUUID = CBUUID(string: PendantGATT.batteryLevel)
    private let omiAudioUUID = CBUUID(string: OmiGATT.audioService)
    private let omiStorageUUID = CBUUID(string: OmiGATT.storageService)
    /// The Omi's ring: commands are written to it and its notifications are the data.
    private let omiControlUUID = CBUUID(string: OmiGATT.storageControl)
    private let omiTimeUUID = CBUUID(string: OmiGATT.timeService)
    private let omiClockUUID = CBUUID(string: OmiGATT.timeWrite)
    private let deviceInfoUUID = CBUUID(string: OmiGATT.deviceInfoService)
    private let firmwareRevisionUUID = CBUUID(string: OmiGATT.firmwareRevision)

    public nonisolated let events: AsyncStream<TransportEvent>
    private let continuation: AsyncStream<TransportEvent>.Continuation
    private let queue: DispatchSerialQueue
    private let central: CBCentralManager
    private let delegate: Delegate
    private var peripheral: CBPeripheral?
    private var discovered: [UUID: CBPeripheral] = [:]
    /// Which pendant the link's services say this is.
    private var kind: DeviceKind?
    private var controlCharacteristic: CBCharacteristic?
    private var clockCharacteristic: CBCharacteristic?
    private var batteryCharacteristic: CBCharacteristic?
    private var notifying = false
    private var reportedReady = false
    private var wantsScan = false
    private var wantedPeripheral: UUID?
    private var writes:
        [(data: Data, target: WriteTarget, done: CheckedContinuation<Result<Void, TransportError>, Never>)] = []
    private var writeInFlight = false

    public nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    /// Build it synchronously during launch (`application(_:didFinishLaunchingWithOptions:)`'s call path): the central
    /// is recreated here, with its restore identifier, so a background relaunch hands the peripheral back.
    public init(restoreIdentifier: String = "pendant") {
        (events, continuation) = AsyncStream.makeStream()
        let queue = DispatchSerialQueue(label: "lifelog.pendant.bluetooth")
        let delegate = Delegate()
        self.queue = queue
        self.delegate = delegate
        // No callback may run before the delegate knows its owner, which needs `self` whole, after the central.
        queue.suspend()
        central = CBCentralManager(
            delegate: delegate, queue: queue,
            options: [
                CBCentralManagerOptionRestoreIdentifierKey: restoreIdentifier,
                CBCentralManagerOptionShowPowerAlertKey: false,
            ])
        delegate.owner = self
        queue.resume()
    }

    // MARK: PendantTransport

    /// The central exists since `init`; its first state and any restoration are already on `events`.
    public func start() {}

    public func scan() {
        wantsScan = true
        guard central.state == .poweredOn else { return }
        // Background scans must name a service; foreground ones do too, to save power. An Omi advertises its audio service.
        central.scanForPeripherals(withServices: [serviceUUID, omiAudioUUID])
    }

    public func stopScan() {
        wantsScan = false
        central.stopScan()
    }

    public func connect(_ id: UUID) {
        wantedPeripheral = id
        guard central.state == .poweredOn else { return }  // resumed on .poweredOn
        guard
            let target = peripheral?.identifier == id
                ? peripheral : discovered[id] ?? central.retrievePeripherals(withIdentifiers: [id]).first
        else {
            continuation.yield(.disconnected(id, .connectFailed("unknown peripheral")))
            return
        }
        peripheral = target
        target.delegate = delegate
        if target.state == .connected {
            // Restored while connected: services and notify must be set up again before any command.
            linkUp(target)
        } else {
            central.connect(target)  // never times out
        }
    }

    public func disconnect() {
        wantedPeripheral = nil
        if let peripheral { central.cancelPeripheralConnection(peripheral) }
    }

    public func write(_ bytes: Data, to target: WriteTarget) async throws(TransportError) {
        guard peripheral?.state == .connected, characteristic(for: target) != nil else { throw .notReady }
        let result = await withCheckedContinuation { done in
            writes.append((bytes, target, done))
            pumpWrites()
        }
        try result.get()
    }

    public func readBattery() {
        guard let peripheral, peripheral.state == .connected, let batteryCharacteristic else { return }
        peripheral.readValue(for: batteryCharacteristic)
    }

    // MARK: Delegate callbacks (on the queue)

    fileprivate func didUpdateState(_ state: CBManagerState) {
        let availability: BluetoothAvailability =
            switch state {
            case .poweredOn: .poweredOn
            case .poweredOff: .poweredOff
            case .unauthorized: .unauthorized
            case .unsupported: .unsupported
            default: .unknown
            }
        if availability != .poweredOn { resetLink(failingWritesWith: .notReady) }
        continuation.yield(.availability(availability))
        guard availability == .poweredOn else { return }
        if wantsScan { scan() }
        if let wantedPeripheral { connect(wantedPeripheral) }
    }

    fileprivate func willRestore(_ match: CBPeripheral) {
        peripheral = match
        match.delegate = delegate
        wantedPeripheral = match.identifier
        continuation.yield(.restored(match.identifier))
    }

    fileprivate func didDiscover(_ found: CBPeripheral, name: String?) {
        discovered[found.identifier] = found
        continuation.yield(.discovered(DiscoveredPendant(id: found.identifier, name: name ?? found.name)))
    }

    fileprivate func didConnect(_ connected: CBPeripheral) {
        guard connected.identifier == peripheral?.identifier else { return }
        linkUp(connected)
    }

    fileprivate func didDisconnect(_ lost: CBPeripheral, error: (any Error)?, failedToConnect: Bool) {
        guard lost.identifier == peripheral?.identifier else { return }
        resetLink(failingWritesWith: .notReady)
        let detail = error?.localizedDescription
        let reason: DisconnectReason =
            failedToConnect ? .connectFailed(detail) : error == nil ? .cancelled : .linkLost(detail)
        continuation.yield(.disconnected(lost.identifier, reason))
    }

    fileprivate func didDiscoverServices(_ target: CBPeripheral, error: (any Error)?) {
        guard error == nil, let services = target.services else { return drop(target) }
        kind = services.contains { $0.uuid == omiStorageUUID } ? .omi : .limitless
        for service in services {
            switch service.uuid {
            case serviceUUID: target.discoverCharacteristics([controlUUID, dataUUID], for: service)
            case batteryServiceUUID: target.discoverCharacteristics([batteryLevelUUID], for: service)
            case omiStorageUUID: target.discoverCharacteristics([omiControlUUID], for: service)
            case omiTimeUUID: target.discoverCharacteristics([omiClockUUID], for: service)
            case deviceInfoUUID where kind == .omi: target.discoverCharacteristics([firmwareRevisionUUID], for: service)
            default: break
            }
        }
    }

    fileprivate func didDiscoverCharacteristics(_ target: CBPeripheral, service: CBService, error: (any Error)?) {
        guard error == nil else { return drop(target) }
        for characteristic in service.characteristics ?? [] {
            switch characteristic.uuid {
            case controlUUID: controlCharacteristic = characteristic
            // Subscribing to the encrypted data characteristic is what triggers bonding on iOS.
            case dataUUID: target.setNotifyValue(true, for: characteristic)
            case omiControlUUID:
                controlCharacteristic = characteristic
                target.setNotifyValue(true, for: characteristic)
            case omiClockUUID: clockCharacteristic = characteristic
            case firmwareRevisionUUID: target.readValue(for: characteristic)
            case batteryLevelUUID:
                batteryCharacteristic = characteristic
                target.readValue(for: characteristic)
                target.setNotifyValue(true, for: characteristic)
            default: break
            }
        }
        reportReady(target)
    }

    fileprivate func didUpdateNotificationState(
        _ target: CBPeripheral, characteristic: CBCharacteristic, error: (any Error)?
    ) {
        guard [dataUUID, omiControlUUID].contains(characteristic.uuid) else { return }
        if let error {
            if Self.needsBonding(error) {
                // ponytail: after the owner accepts the pairing sheet, the next reconnect subscribes cleanly.
                continuation.yield(.pairingRequired(target.identifier))
            } else {
                drop(target)
            }
            return
        }
        notifying = characteristic.isNotifying
        reportReady(target)
    }

    /// Once notifications flow and every characteristic a command needs is known: an Omi's clock comes first.
    private func reportReady(_ target: CBPeripheral) {
        guard !reportedReady, notifying, controlCharacteristic != nil, let kind,
            kind == .limitless || clockCharacteristic != nil
        else { return }
        reportedReady = true
        continuation.yield(.ready(target.identifier, kind))
    }

    fileprivate func didUpdateValue(_ characteristic: CBCharacteristic, value: Data?) {
        guard let value else { return }
        switch characteristic.uuid {
        case dataUUID, omiControlUUID: continuation.yield(.notification(value))
        case batteryLevelUUID: if let level = value.first { continuation.yield(.batteryLevel(Int(level))) }
        case firmwareRevisionUUID: continuation.yield(.firmwareRevision(String(decoding: value, as: UTF8.self)))
        default: break
        }
    }

    fileprivate func didWrite(error: (any Error)?) {
        guard writeInFlight, !writes.isEmpty else { return }
        writeInFlight = false
        let done = writes.removeFirst().done
        switch error {
        case nil: done.resume(returning: .success(()))
        case let error? where Self.needsBonding(error): done.resume(returning: .failure(.insufficientAuthentication))
        case let error?: done.resume(returning: .failure(.writeFailed(error.localizedDescription)))
        }
        pumpWrites()
    }

    // MARK: Helpers

    private func linkUp(_ target: CBPeripheral) {
        continuation.yield(.linkUp(target.identifier))
        target.discoverServices([
            serviceUUID, batteryServiceUUID, omiStorageUUID, omiTimeUUID, deviceInfoUUID,
        ])
    }

    /// One write with response at a time, so commands reach the Pendant in order.
    private func pumpWrites() {
        guard !writeInFlight, let next = writes.first else { return }
        guard let peripheral, let characteristic = characteristic(for: next.target), peripheral.state == .connected
        else {
            return resetLink(failingWritesWith: .notReady)
        }
        writeInFlight = true
        peripheral.writeValue(next.data, for: characteristic, type: .withResponse)
    }

    private func characteristic(for target: WriteTarget) -> CBCharacteristic? {
        switch target {
        case .control: controlCharacteristic
        case .clock: clockCharacteristic
        }
    }

    private func resetLink(failingWritesWith error: TransportError) {
        kind = nil
        controlCharacteristic = nil
        clockCharacteristic = nil
        batteryCharacteristic = nil
        notifying = false
        reportedReady = false
        writeInFlight = false
        let pending = writes
        writes = []
        for write in pending { write.done.resume(returning: .failure(error)) }
    }

    /// Discovery failed: drop the link; the pending reconnect brings it back.
    private func drop(_ target: CBPeripheral) {
        central.cancelPeripheralConnection(target)
    }

    private static func needsBonding(_ error: any Error) -> Bool {
        guard let error = error as? CBATTError else { return false }
        return [.insufficientAuthentication, .insufficientEncryption, .insufficientEncryptionKeySize].contains(
            error.code)
    }
}

/// CoreBluetooth calls these on the transport's own queue, which is the actor's executor.
private final class Delegate: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    /// Set in the transport's `init` before its queue runs anything, so never `nil` in a callback.
    unowned var owner: CoreBluetoothTransport!

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let state = central.state
        owner.assumeIsolated { $0.didUpdateState(state) }
    }

    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        // The system restores at most our one Pendant.
        guard let restored = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral])?.first else {
            return
        }
        owner.assumeIsolated { $0.willRestore(restored) }
    }

    func centralManager(
        _ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        owner.assumeIsolated { $0.didDiscover(peripheral, name: name) }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        owner.assumeIsolated { $0.didConnect(peripheral) }
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: (any Error)?) {
        owner.assumeIsolated { $0.didDisconnect(peripheral, error: error, failedToConnect: true) }
    }

    func centralManager(
        _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: (any Error)?
    ) {
        owner.assumeIsolated { $0.didDisconnect(peripheral, error: error, failedToConnect: false) }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: (any Error)?) {
        owner.assumeIsolated { $0.didDiscoverServices(peripheral, error: error) }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: (any Error)?) {
        owner.assumeIsolated { $0.didDiscoverCharacteristics(peripheral, service: service, error: error) }
    }

    func peripheral(
        _ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: (any Error)?
    ) {
        owner.assumeIsolated { $0.didUpdateNotificationState(peripheral, characteristic: characteristic, error: error) }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: (any Error)?)
    {
        let value = error == nil ? characteristic.value : nil
        owner.assumeIsolated { $0.didUpdateValue(characteristic, value: value) }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: (any Error)?)
    {
        owner.assumeIsolated { $0.didWrite(error: error) }
    }
}
