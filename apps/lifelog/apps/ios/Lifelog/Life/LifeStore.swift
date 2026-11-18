import Foundation
import Library
import LifeConnector
import Observation
import UserNotifications

/// The phone's side of Life: its four reads, each a `ReadState`, his actions, each an `ActionState`, the push and the badge,
/// and the pairing that makes them possible. The app
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

    /// Every action, by what it acts on (`answer:<ref>`, `start:<matter>`, `agent:<id>`, `matter:<id>`): its steps as they stream, then its proof or why not.
    private(set) var actions: [String: ActionState<ActionProof>] = [:]
    /// The card a tapped push opened, for the screen to show (`wasAnswered`: it had left the inbox).
    private(set) var openedCard: InboxOpening?

    private(set) var pairingStep: PairingStep?
    private(set) var pairingFailure: String?

    private let tokens: any TokenStore
    private let api: any LifeAPI
    private let cache: ReadCache
    private let runner: LifeActions
    private let now: @Sendable () -> Date
    private let setBadge: @MainActor (Int) -> Void
    /// The key of a tap whose call may have run (its connection failed): the same tap repeats with it, so Life sends nothing twice.
    private var answerKeys: [String: String] = [:]

    init(
        tokens: any TokenStore = LifeToken(), api: (any LifeAPI)? = nil,
        cache: ReadCache = ReadCache(directory: URL.applicationSupportDirectory.appending(path: "lifelog/life-reads")),
        now: @escaping @Sendable () -> Date = { Date() },
        setBadge: @escaping @MainActor (Int) -> Void = { count in
            Task { try? await UNUserNotificationCenter.current().setBadgeCount(count) }
        }
    ) {
        self.tokens = tokens
        let api = api ?? MCPLifeAPI(client: MCPClient(session: LifeSession(store: tokens)))
        self.api = api
        runner = LifeActions(api: api, now: now)
        self.cache = cache
        self.now = now
        self.setBadge = setBadge
        restore({ self.inbox.apply($0) }, key: Self.inboxKey)
        restore({ self.matters.apply($0) }, key: Self.mattersKey)
        restore({ self.agents.apply($0) }, key: Self.agentsKey)
    }

    var isPaired: Bool { tokens.load() != nil }

    // MARK: Reads

    /// Every read, side by side: on foreground, on a push, after an action.
    func refresh() async {
        async let a: Void = refreshInbox()
        async let b: Void = refreshMatters()
        async let c: Void = refreshAgents()
        _ = await (a, b, c)
    }

    func refreshInbox() async {
        await load({ self.inbox.apply($0) }, key: Self.inboxKey) { try await $0.readInbox() }
        // The badge is every open card.
        if let total = inbox.value?.total { setBadge(total) }
    }
    func refreshMatters() async {
        await load({ self.matters.apply($0) }, key: Self.mattersKey) { try await $0.readMatters() }
    }
    func refreshAgents() async {
        await load({ self.agents.apply($0) }, key: Self.agentsKey) { try await $0.readRegisteredAgents() }
    }

    func refreshMatter(_ id: String) async {
        let key = "read_matter-\(id)"
        let update = { (event: ReadState<Matter>.Event) in self.matter[id, default: ReadState()].apply(event) }
        // Offline, a matter not read yet since launch still shows what was last read, as stale.
        if matter[id] == nil { restore(update, key: key) }
        await load(update, key: key) {
            try await $0.readMatter(id)
        }
    }

    private static let inboxKey = "read_inbox"
    private static let mattersKey = "read_matters"
    private static let agentsKey = "read_registered_agents"

    private func restore<V: Decodable & Sendable>(_ update: (ReadState<V>.Event) -> Void, key: String) {
        guard let kept = cache.load(key),
            let value = try? LibraryStore.feedDecoder.decode(V.self, from: Data(kept.text.utf8))
        else { return }
        update(.succeeded(value, kept.at))
    }

    private func load<V: Decodable & Sendable>(
        _ update: (ReadState<V>.Event) -> Void, key: String,
        fetch: @Sendable (any LifeAPI) async throws -> String
    ) async {
        update(.started)
        do {
            let text = try await fetch(api)
            let value = try LibraryStore.feedDecoder.decode(V.self, from: Data(text.utf8))
            cache.store(text, key: key)
            update(.succeeded(value, now()))
        } catch let error as MCPError {
            update(.failed(error))
        } catch {
            update(.failed(.failed("Life's answer was not what this app reads.")))
        }
    }

    // MARK: Actions

    /// Runs one action under `key`: its events are applied in the order they came, and a second tap while it runs is ignored.
    private func perform(_ key: String, _ body: @escaping @Sendable (@escaping LifeActions.Emit) async -> Void) async {
        guard actions[key]?.isRunning != true else { return }
        let (events, emit) = AsyncStream.makeStream(of: ActionState<ActionProof>.Event.self)
        actions[key] = .idle
        let consumer = Task { for await event in events { actions[key, default: .idle].apply(event) } }
        await body { emit.yield($0) }
        emit.finish()
        await consumer.value
    }

    /// His answer to a check. A call that failed on the connection is repeated as the same tap; a result Life gave
    /// (a send that was not sent included) makes the next tap a new one.
    func answer(_ request: AnswerRequest) async {
        let key = "answer:\(request.ref)"
        guard actions[key]?.isRunning != true else { return }
        let tap = answerKeys[request.ref] ?? UUID().uuidString
        answerKeys[request.ref] = tap
        await perform(key) { [runner] in await runner.answer(request, key: tap, emit: $0) }
        if case .failed(let failure, _)? = actions[key], failure.isSameTap {} else { answerKeys[request.ref] = nil }
        await refreshInbox()
    }

    /// Saves `goal` as the matter's goal, then starts an agent on it: `goal_saved`, then the desk's stages.
    func startAgent(on matter: Matter, goal: String, runtime: String? = nil, model: String? = nil) async {
        let (id, steps) = (matter.row.id, matter.steps.map(\.ref))
        await perform("start:\(id)") { [runner] in
            await runner.startAgent(
                matter: id, steps: steps, goal: goal, runtime: runtime, model: model, emit: $0)
        }
        async let a: Void = refreshMatter(id)
        async let b: Void = refreshAgents()
        _ = await (a, b)
    }

    func stopAgent(_ agent: String) async {
        await change(agent, AgentRequest(action: .stop, agent: agent, said: "Stop it."))
    }
    func resumeAgent(_ agent: String) async {
        await change(agent, AgentRequest(action: .resume, agent: agent, said: "Resume it."))
    }
    func changeModel(of agent: String, to model: String, effort: String? = nil) async {
        await change(
            agent,
            AgentRequest(
                action: .changeModel, agent: agent, model: model, effort: effort, said: "Use \(model) for this agent."))
    }

    private func change(_ agent: String, _ request: AgentRequest) async {
        await perform("agent:\(agent)") { [runner] in await runner.changeAgent(request, emit: $0) }
        await refreshAgents()
    }

    /// His goal for a matter (`matter-direction`, pinned to every step `read_matter` lists).
    func setGoal(of matter: Matter, _ goal: String) async {
        let (api, steps) = (api, matter.steps.map(\.ref))
        await edit(matter, "goal") { try await api.setMatterDirection(steps: steps, goal: goal, nextStep: nil) }
    }

    func setNextStep(of matter: Matter, _ nextStep: NextStepRequest) async {
        let (api, steps) = (api, matter.steps.map(\.ref))
        await edit(matter, "next") { try await api.setMatterDirection(steps: steps, goal: nil, nextStep: nextStep) }
    }

    /// His word that the matter is done: its open steps are outdated.
    func markDone(_ matter: Matter) async {
        let (api, open) = (api, matter.steps.filter { $0.ending == nil && $0.ref.hasPrefix("obs_") }.map(\.ref))
        await edit(matter, "done") { try await api.markDone(observations: open, note: "Marked done in the Life app.") }
    }

    /// Ticks one of his to-do items, as he does it on the phone.
    func tickTodoItem(title: String, target: String) async {
        let api = api
        await perform("todo:\(target)") { [runner] in
            await runner.record(emit: $0) {
                try await api.changeTodoItem(
                    kind: "done", title: title, target: target, said: "Ticked in the Life app: \(title)")
            }
        }
    }

    private func edit(_ matter: Matter, _ what: String, _ change: @escaping @Sendable () async throws -> String) async {
        let id = matter.row.id
        await perform("matter:\(id):\(what)") { [runner] in await runner.record(emit: $0, change) }
        async let a: Void = refreshMatter(id)
        async let b: Void = refreshMatters()
        _ = await (a, b)
    }

    /// A tapped push: the inbox is read again and the card with that `pushId` is the one opened; one that already
    /// left (answered elsewhere) opens the first card waiting, marked `wasAnswered`.
    func open(pushId: String) async {
        await refreshInbox()
        openedCard = inbox.value?.opening(pushId: pushId)
    }

    // MARK: Pairing

    /// Registers this app with Life, has the pairing code approve it, then reads the inbox as the first proof.
    func pair(_ link: LifePairing) async {
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
