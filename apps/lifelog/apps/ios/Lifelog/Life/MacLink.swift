import Foundation
import IrohLib
import Library
import Network
import Synchronization

/// Why a Mac could not be reached over iroh, or would not take this phone.
nonisolated enum MacLinkError: Error, Equatable {
    /// No Mac to dial: nothing is pointed at one (a pairing that names no `mac=`).
    case notPointed
    /// The Keychain would not keep this install's key, so no endpoint could be made.
    case noSecretKey
    /// The Mac answered a live code's proof with `refused` (`provePairing`, Life's `oauth.ts`).
    case refused
}

/// The phone's path to its Mac over iroh: one endpoint, one connection to the Mac's key, and a bridge on this phone's
/// loopback that every request for the paired origin goes through (`MacRoute`), so the clients keep speaking plain
/// HTTP/1.1 to the address they know. The Mac accepts `life/http/1` only from a phone endpoint id that proved a live
/// pairing code on `life/pair/1` first, so this endpoint's secret key is kept in the Keychain: one id per install, the
/// same one after every launch.
///
/// Privacy (`SECURITY.md`, "What leaves the Mac"): what leaves this phone is the requests it makes to its own Mac, in
/// QUIC streams encrypted between the two endpoint keys, and nothing else; the Mac's answers come back the same way.
/// n0's public relay, the one the pairing names (`relay=`), carries those packets whenever the two cannot reach each
/// other directly, and sees what a relay sees: the two endpoint ids, the two IP addresses, when each was online and how
/// much they exchanged, never a byte inside. Turning it off is unpairing the phone, or quitting Life on the Mac: with
/// no Mac to reach, no endpoint is made and no packet leaves. The secret key never leaves the phone: it signs.
@MainActor
final class MacLink {
    static let shared = MacLink()

    /// IrohLib's connection. The phone's own `Connection` (Life or the pendant server, `ConnectionCheck`) is another
    /// thing, and this file's name is the library's.
    private typealias Connection = IrohLib.Connection

    /// The ALPN one pairing code goes on (`prove`), before the Mac pipes anything for this phone.
    nonisolated static let pairAlpn = "life/pair/1"
    /// The ALPN whose every stream is one raw TCP connection to the Mac's HTTP port.
    nonisolated static let httpAlpn = "life/http/1"
    /// Where this install's endpoint key is kept: the app's Keychain service, so its endpoint id survives launches.
    private nonisolated static let secretAccount = "life-iroh-key"
    /// The listener's and the pipes' own queue, off the main actor.
    private nonisolated static let queue = DispatchQueue(label: "life.maclink", qos: .userInitiated)
    fileprivate nonisolated static let chunk = 64 * 1024

    /// The Mac this phone reaches now: nil until a pairing names one (and after one that names none).
    private(set) var target: MacTarget?
    /// The endpoint held now, and the Mac key it was made for: another key or relay makes another endpoint.
    private var endpoint: (mac: MacKey, endpoint: Endpoint)?
    /// The Mac's `life/http/1` connection, dialed when a request arrives and none is live (`background sync` and a
    /// network change alike), dropped when it dies.
    private var connection: Connection?
    /// The dial under way: requests arriving together wait on one dial, never start another.
    private var dialing: Task<Connection, any Error>?
    /// The bridge on this phone's loopback, its listener and the identity a late failure is checked against.
    private var listener: NWListener?
    private var listenerID = UUID()
    /// The point under way, which the next one awaits: a cold launch calls `point(at:)` twice at once, and the second
    /// would pass the guard while the first awaits its endpoint.
    private var pointing: Task<Void, Never>?

    // MARK: Where the Mac is

    /// Points the phone at its Mac, and starts the bridge: on launch, from the stored pairing at `LifeEndpoint.mac`,
    /// and by a pairing (`PairSheet`, which restores the old one if it fails). Nil tears the bridge down, and every
    /// request goes to its origin again. One point runs at a time: a second waits for the one under way, so two calls
    /// from a cold launch make one endpoint and one listener, not two.
    func point(at target: MacTarget?) async {
        await queuePoint { target }
    }

    /// The bridge again when the app comes forward: a dial that failed left the requests on the Mac's origin, and iroh
    /// gets its next try with the same Mac (`MacLink` dials when a request reaches the bridge). The Mac is the one the
    /// pairing pointed at when its turn comes, never a stale one.
    func relink() async { await queuePoint { self.target } }

    /// One point, the next one waiting for it: the Mac is read when this point's turn comes, never when it was queued,
    /// so a `relink` behind a pairing that has not pointed yet waits and then follows it.
    private func queuePoint(_ target: @escaping @MainActor () -> MacTarget?) async {
        let previous = pointing
        let task = Task {
            await previous?.value
            let mac = target()
            // The same Mac is pointed at again when the app comes forward, to rebuild a bridge whose dial gave up.
            guard mac != self.target || (mac != nil && MacRoute.current == nil) else { return }
            await stop()
            self.target = mac
            guard let mac else { return }
            do { try await start(mac) } catch {
                appEvent("maclink.start.failed", ["origin": mac.origin.scheme ?? ""])
                await stop()
            }
        }
        pointing = task
        await task.value
    }

    /// The bridge: a loopback listener whose every connection becomes one stream of the Mac's `life/http/1` connection,
    /// and the hook that sends this origin's requests there (`MacRoute`).
    private func start(_ target: MacTarget) async throws {
        // The endpoint first: a key or relay it refuses fails here, before anything routes to the bridge.
        _ = try await endpoint(for: target.key)
        let parameters = NWParameters.tcp
        // This phone's own loopback only: nothing outside it can reach the bridge.
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters)
        let id = UUID()
        listenerID = id
        listener.newConnectionHandler = { MacLink.accepted($0) }
        try await withCheckedThrowingContinuation { (ready: CheckedContinuation<Void, any Error>) in
            // A `.setup` or `.waiting` before `.ready` is waited through: only a terminal state answers, and only once.
            let isWaiting = Mutex(true)
            listener.stateUpdateHandler = { state in
                let isTerminal =
                    switch state {
                    case .ready, .failed, .cancelled: true
                    default: false
                    }
                let first =
                    isTerminal
                    && isWaiting.withLock { waiting in
                        defer { waiting = false }
                        return waiting
                    }
                switch state {
                case .ready where first: ready.resume()
                case .failed(let error):
                    if first { ready.resume(throwing: error) }
                    Task { @MainActor in MacLink.shared.listenerFailed(id) }
                case .cancelled where first: ready.resume(throwing: MacLinkError.notPointed)
                default: break
                }
            }
            listener.start(queue: Self.queue)
        }
        self.listener = listener
        guard let port = listener.port?.rawValue, port != 0, let host = target.origin.host() else {
            throw MacLinkError.notPointed
        }
        MacRoute.current = MacRoute.Bridge(host: host, port: port)
        appEvent("maclink.bridge", ["port": String(port)])
    }

    /// Nothing is pointed at a Mac any more: no bridge, no connection, no endpoint.
    private func stop() async {
        MacRoute.current = nil
        listener?.cancel()
        listener = nil
        listenerID = UUID()
        connection = nil
        dialing?.cancel()
        dialing = nil
        if let endpoint {
            self.endpoint = nil
            try? await endpoint.endpoint.close()
        }
    }

    /// The bridge died while nothing asked it anything: every request goes to its origin until the next dial.
    private func listenerFailed(_ id: UUID) {
        guard id == listenerID else { return }
        appEvent("maclink.bridge.failed")
        listener?.cancel()
        listener = nil
        listenerID = UUID()
        connection = nil
        MacRoute.current = nil
    }

    // MARK: Pairing

    /// Writes `code` on `life/pair/1` and waits for the Mac's own answer: whether it bound this phone's endpoint id to
    /// the live pairing. The Mac answers `ok` or `refused`; anything else, or no answer, is not an `ok`. The connection is
    /// closed on every path, the throwing ones included: the Mac waits up to 10 s for this phone to hang up.
    /// Throws when the Mac cannot be reached at all, which the pairing shows as a failed step like a refusal.
    func prove(code: String) async throws -> Bool {
        guard let target else { throw MacLinkError.notPointed }
        let endpoint = try await endpoint(for: target.key)
        let connection = try await endpoint.connect(
            addr: try Self.address(of: target.key), alpn: Data(Self.pairAlpn.utf8))
        let isProved: Bool
        do {
            let stream = try await connection.openBi()
            let send = stream.send()
            try await send.writeAll(buf: Data(code.utf8))
            try await send.finish()
            let answer = try await stream.recv().readToEnd(sizeLimit: 16)
            isProved = String(decoding: answer, as: UTF8.self).hasPrefix("ok")
        } catch {
            try? connection.close(errorCode: 0, reason: Data())
            throw error
        }
        try? connection.close(errorCode: 0, reason: Data())
        appEvent("maclink.prove", ["ok": isProved ? "1" : "0"])
        return isProved
    }

    // MARK: The bridge's side

    /// One TCP connection from this phone: its own task and its own stream, so the bridge never waits on it.
    private nonisolated static func accepted(_ connection: NWConnection) {
        let pipe = Pipe(connection: connection)
        Task {
            do {
                let stream = try await MacLink.shared.openStream()
                await pump(pipe, stream)
            } catch {
                appEvent("maclink.pipe.failed")
                pipe.connection.cancel()
            }
        }
    }

    /// One stream of the Mac's `life/http/1` connection, dialing the connection when none is live. A connection that
    /// outlived its network is dialed again once; a dial that fails is the bridge giving up (`gaveUp`).
    func openStream() async throws -> BiStream {
        guard let target else { throw MacLinkError.notPointed }
        let held: Connection
        do {
            held = try await live(target.key)
        } catch {
            gaveUp(target)
            throw error
        }
        do {
            return try await held.openBi()
        } catch {
            connection = nil
            do { return try await live(target.key).openBi() } catch {
                gaveUp(target)
                throw error
            }
        }
    }

    /// The Mac's live connection, or one dial that requests arriving together share.
    private func live(_ mac: MacKey) async throws -> Connection {
        if let connection, connection.closeReason() == nil { return connection }
        connection = nil
        if let dialing { return try await dialing.value }
        let dialing = Task { try await self.dial(mac) }
        self.dialing = dialing
        defer { self.dialing = nil }
        return try await dialing.value
    }

    private func dial(_ mac: MacKey) async throws -> Connection {
        let endpoint = try await endpoint(for: mac)
        let connection = try await endpoint.connect(
            addr: try Self.address(of: mac), alpn: Data(Self.httpAlpn.utf8))
        self.connection = connection
        appEvent("maclink.dial")
        return connection
    }

    /// No dial: Life at its https origin (Tailscale) carries the requests again; a loopback origin keeps the address it
    /// has, which is this Mac's own port for the simulator and nothing another phone could fall back to.
    private func gaveUp(_ target: MacTarget) {
        appEvent("maclink.gaveup")
        connection = nil
        if target.origin.scheme == "https" { MacRoute.current = nil }
    }

    // MARK: The endpoint

    /// The endpoint for one Mac key: made once, kept while the key and its relay hold. Minimal preset (no discovery, no
    /// n0 default): the one relay the pairing named, and this install's kept key.
    private func endpoint(for mac: MacKey) async throws -> Endpoint {
        if let endpoint, endpoint.mac == mac { return endpoint.endpoint }
        if let endpoint {
            self.endpoint = nil
            try? await endpoint.endpoint.close()
        }
        let builder = EndpointBuilder()
        builder.applyMinimal()
        guard let secret = Self.secretKey() else { throw MacLinkError.noSecretKey }
        try builder.secretKey(bytes: secret.toBytes())
        builder.relayMode(mode: try RelayMode.customFromUrls(urls: [mac.relay.absoluteString]))
        builder.alpns(alpns: [Data(Self.pairAlpn.utf8), Data(Self.httpAlpn.utf8)])
        let made = try await builder.bind()
        endpoint = (mac, made)
        appEvent("maclink.endpoint", ["id": made.id().fmtShort()])
        return made
    }

    /// This install's one iroh secret key: made on the first launch that needs it, kept in the Keychain (this device
    /// only, after the first unlock), so the Mac's pairing holds across launches.
    private nonisolated static func secretKey() -> SecretKey? {
        if let kept = Keychain.read(secretAccount), let bytes = Data(base64Encoded: kept),
            let key = try? SecretKey.fromBytes(bytes: bytes)
        {
            return key
        }
        let made = SecretKey.generate()
        guard Keychain.save(made.toBytes().base64EncodedString(), account: secretAccount) else { return nil }
        return made
    }

    private nonisolated static func address(of mac: MacKey) throws -> EndpointAddr {
        EndpointAddr(
            id: try EndpointId.fromString(s: mac.id), relayUrl: mac.relay.absoluteString, addresses: [])
    }

    // MARK: A connection's bytes

    /// Bytes both ways until either side ends: `HTTP/1.1` over one stream, in order, each direction its own.
    private nonisolated static func pump(_ pipe: Pipe, _ stream: BiStream) async {
        let send = stream.send()
        let recv = stream.recv()
        pipe.connection.start(queue: queue)
        async let toMac: Void = up(pipe, send)
        async let toPhone: Void = down(pipe, recv)
        _ = await (toMac, toPhone)
        pipe.connection.cancel()
    }

    /// This phone's request bytes: each chunk written whole and in order; its side ending finishes the stream, and its
    /// answer still comes back until the Mac hangs up.
    private nonisolated static func up(_ pipe: Pipe, _ send: SendStream) async {
        do {
            while let chunk = try await pipe.received() {
                if !chunk.isEmpty { try await send.writeAll(buf: chunk) }
            }
            try await send.finish()
        } catch {
            try? await send.reset(errorCode: 0)
        }
    }

    /// The Mac's answer: each chunk handed to the TCP connection in order, until the stream ends or breaks, which ends
    /// the connection (`pump`).
    private nonisolated static func down(_ pipe: Pipe, _ recv: RecvStream) async {
        do {
            while true {
                let chunk = try await recv.read(sizeLimit: UInt32(Self.chunk))
                guard !chunk.isEmpty else { break }
                try await pipe.write(chunk)
            }
        } catch {}
    }
}

/// One accepted TCP connection of the bridge. Network's class is not `Sendable` (its calls are thread-safe); the pipe
/// takes it once and keeps it to itself.
private nonisolated struct Pipe: @unchecked Sendable {
    let connection: NWConnection

    /// What the phone's client sent, one read at a time: nil once its side ended.
    func received() async throws -> Data? {
        try await withCheckedThrowingContinuation { (read: CheckedContinuation<Data?, any Error>) in
            connection.receive(minimumIncompleteLength: 1, maximumLength: MacLink.chunk) {
                data, _, isComplete, error in
                if let error { read.resume(throwing: error); return }
                if let data, !data.isEmpty { read.resume(returning: data); return }
                read.resume(returning: isComplete ? nil : Data())
            }
        }
    }

    func write(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { (written: CheckedContinuation<Void, any Error>) in
            connection.send(
                content: data,
                completion: .contentProcessed { error in
                    if let error { written.resume(throwing: error) } else { written.resume() }
                })
        }
    }
}
