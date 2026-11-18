import Foundation
import LifeConnector
import Observation
import ServerAPI

/// The phone's side of Life: its four reads, each a `ReadState`, and the pairing that makes them possible. The app
/// holds no second API: everything goes through Life's connector (`LifeConnector`, in Kit). A cold start fills each
/// read from the last good answer, so with no Mac in reach a screen shows it as stale, never blank.
@MainActor @Observable
final class LifeStore {
    /// What the pairing is doing, as it runs (`LifeOAuth.Step`), then reading the inbox.
    enum PairingStep: String { case registering, approving, exchanging, readingInbox = "reading_inbox" }

    private(set) var inbox = ReadState<Inbox>()
    private(set) var matters = ReadState<MatterList>()
    private(set) var matter: [String: ReadState<Matter>] = [:]
    private(set) var agents = ReadState<RegisteredAgents>()

    /// A pairing link opened from outside, waiting for the owner to confirm it: never acted on alone.
    var offered: LifePairing?
    private(set) var pairingStep: PairingStep?
    private(set) var pairingFailure: String?

    private let tokens: any TokenStore
    private let api: any LifeAPI
    private let cache: ReadCache
    private let now: @Sendable () -> Date

    init(
        tokens: any TokenStore = LifeToken(), api: (any LifeAPI)? = nil,
        cache: ReadCache = ReadCache(directory: URL.applicationSupportDirectory.appending(path: "lifelog/life-reads")),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.tokens = tokens
        self.api = api ?? MCPLifeAPI(client: MCPClient(session: LifeSession(store: tokens)))
        self.cache = cache
        self.now = now
        restore(\.inbox, key: Self.inboxKey)
        restore(\.matters, key: Self.mattersKey)
        restore(\.agents, key: Self.agentsKey)
    }

    var isPaired: Bool { tokens.load() != nil }
    /// Life's address as the owner reads it, once paired.
    var host: String? { tokens.load()?.endpoint.origin.host() }

    // MARK: Reads

    /// Every read, side by side: on foreground, on a push, after an action.
    func refresh() async {
        async let a: Void = refreshInbox()
        async let b: Void = refreshMatters()
        async let c: Void = refreshAgents()
        _ = await (a, b, c)
    }

    func refreshInbox() async { await load({ self.inbox.apply($0) }, key: Self.inboxKey) { try await $0.readInbox() } }
    func refreshMatters() async {
        await load({ self.matters.apply($0) }, key: Self.mattersKey) { try await $0.readMatters() }
    }
    func refreshAgents() async {
        await load({ self.agents.apply($0) }, key: Self.agentsKey) { try await $0.readRegisteredAgents() }
    }

    func refreshMatter(_ id: String) async {
        await load({ self.matter[id, default: ReadState()].apply($0) }, key: "read_matter-\(id)") {
            try await $0.readMatter(id)
        }
    }

    private static let inboxKey = "read_inbox"
    private static let mattersKey = "read_matters"
    private static let agentsKey = "read_registered_agents"

    private func restore<V: Decodable & Sendable>(
        _ path: ReferenceWritableKeyPath<LifeStore, ReadState<V>>, key: String
    ) {
        guard let kept = cache.load(key), let value = try? LifeCodec.decode(V.self, from: kept.text) else { return }
        self[keyPath: path].apply(.succeeded(value, kept.at))
    }

    private func load<V: Decodable & Sendable>(
        _ update: (ReadState<V>.Event) -> Void, key: String,
        fetch: @Sendable (any LifeAPI) async throws -> String
    ) async {
        update(.started)
        do {
            let text = try await fetch(api)
            let value = try LifeCodec.decode(V.self, from: text)
            cache.store(text, key: key)
            update(.succeeded(value, now()))
        } catch let error as MCPError {
            update(.failed(error))
        } catch {
            update(.failed(.failed("Life's answer was not what this app reads.")))
        }
    }

    // MARK: Pairing

    /// A pairing link from outside (the Camera, or pasted): its lifelog part goes to `sync`, its Life part here, each
    /// only when the link carries it. The owner confirms both at once (`RootView`).
    func offer(_ link: URL, sync: SyncStore) {
        if let pairing = Pairing(link: link) { sync.offeredPairing = pairing }
        if let life = LifePairing(link: link) { offered = life }
    }

    /// Registers this app with Life, has the pairing code approve it, then reads the inbox as the first proof.
    func pair(_ link: LifePairing) async {
        offered = nil
        pairingFailure = nil
        do {
            let credentials = try await LifeOAuth().pair(link) { step in
                await MainActor.run { self.pairingStep = PairingStep(rawValue: step.rawValue) }
            }
            tokens.save(credentials)
            // Another Life may be this one: nothing of the last one stays.
            cache.clear()
            (inbox, matters, matter, agents) = (ReadState(), ReadState(), [:], ReadState())
            pairingStep = .readingInbox
            await refresh()
        } catch {
            pairingFailure = MCPError.of(error).reason
        }
        pairingStep = nil
    }

    #if DEBUG
        /// Development only: launch with `LIFE_ORIGIN` and `LIFE_PAIRING_CODE` in the environment (for example
        /// `SIMCTL_CHILD_LIFE_ORIGIN=… xcrun simctl launch …`) to pair with that Life, http too. Never in release builds.
        func importFromEnvironment() async {
            let environment = ProcessInfo.processInfo.environment
            guard !isPaired, let origin = environment["LIFE_ORIGIN"].flatMap(URL.init(string:)),
                let code = environment["LIFE_PAIRING_CODE"], !code.isEmpty
            else { return }
            await pair(LifePairing(origin: origin, code: code))
        }
    #endif
}
