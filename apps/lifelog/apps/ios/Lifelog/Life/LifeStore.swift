import Foundation
import Incidents
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
    private(set) var inbox = ReadState<Inbox>()
    private(set) var matters = ReadState<MatterList>()
    private(set) var matter: [String: ReadState<Matter>] = [:]
    private(set) var agents = ReadState<RegisteredAgents>()

    /// What an action acts on: the store makes every key itself, so a screen asks for the state of what it shows.
    enum ActionKey: Hashable {
        case answer(ref: String)
        case start(matter: String)
        case agent(String)
        case edit(matter: String, Edit)
        enum Edit: Hashable { case goal, next, done }
    }

    /// Every action by what it acts on: its steps as they stream, then its proof or why not.
    private(set) var actions: [ActionKey: ActionState<ActionProof>] = [:]
    /// The card a tapped push opened, for the screen to show (`wasAnswered`: it had left the inbox).
    private(set) var openedCard: InboxOpening?

    /// The Life this phone is paired with: set by a pairing, gone once Life no longer knows it (a read says so).
    private(set) var pairedOrigin: URL?

    /// Registers with Life and has the pairing code approve it (`LifeOAuth`); a test or a fixture gives its own.
    typealias Approve = @Sendable (LifePairing) async throws -> LifeCredentials

    private let tokens: any TokenStore
    private let approve: Approve
    private let api: any LifeAPI
    private let cache: ReadCache
    private let runner: LifeActions
    private let now: @Sendable () -> Date
    private let setBadge: @MainActor (Int) -> Void
    /// The key of a tap whose call may have run (its connection failed): the same tap repeats with it, so Life sends nothing twice.
    private var taps = AnswerTaps()

    init(
        tokens: any TokenStore = LifeToken(), api: (any LifeAPI)? = nil,
        approve: @escaping Approve = { try await LifeOAuth().pair($0) },
        cache: ReadCache = ReadCache(directory: URL.applicationSupportDirectory.appending(path: "lifelog/life-reads")),
        now: @escaping @Sendable () -> Date = { Date() },
        setBadge: @escaping @MainActor (Int) -> Void = { count in
            Task { try? await UNUserNotificationCenter.current().setBadgeCount(count) }
        }
    ) {
        self.tokens = tokens
        self.approve = approve
        let api = api ?? MCPLifeAPI(client: MCPClient(session: LifeSession(store: tokens)))
        self.api = api
        runner = LifeActions(api: api, now: now)
        self.cache = cache
        self.now = now
        self.setBadge = setBadge
        pairedOrigin = tokens.load()?.endpoint.origin
        restore({ self.inbox.apply($0) }, key: Self.inboxKey)
        restore({ self.matters.apply($0) }, key: Self.mattersKey)
        restore({ self.agents.apply($0) }, key: Self.agentsKey)
    }

    var isPaired: Bool { pairedOrigin != nil }
    /// Whether Life answers: its inbox read, the one every screen starts from.
    var link: LinkState { outcome.link(hasRead: inbox.value != nil) }

    func state(of key: ActionKey) -> ActionState<ActionProof> { actions[key] ?? .idle }

    /// Forgets an action's result once the screen has shown it (the next card is up, the sheet is closed).
    func forget(_ key: ActionKey) {
        if actions[key]?.isRunning != true { actions[key] = nil }
    }

    /// The card a tapped push opened has been shown.
    func clearOpenedCard() { openedCard = nil }

    // MARK: Reads

    /// Every read, side by side: on foreground, on a push, after an action.
    func refresh() async {
        async let a: Void = refreshInbox()
        async let b: Void = refreshMatters()
        async let c: Void = refreshAgents()
        _ = await (a, b, c)
    }

    /// Whether a first read of the inbox, matters or agents is still missing and worth trying again.
    var needsRetry: Bool { inbox.needsRetry || matters.needsRetry || agents.needsRetry }

    /// Reads again only what has nothing to show yet.
    func retryFirstReads() async {
        async let a: Void = inbox.needsRetry ? refreshInbox() : ()
        async let b: Void = matters.needsRetry ? refreshMatters() : ()
        async let c: Void = agents.needsRetry ? refreshAgents() : ()
        _ = await (a, b, c)
    }

    func refreshInbox() async {
        await load({ self.inbox.apply($0) }, key: Self.inboxKey) { try await $0.readInbox() }
        // The badge is the cards that block him.
        if let badge = inbox.value?.badge { setBadge(badge) }
        if let open = inbox.value?.checks.compactMap(\.pushId) { await removeNotifications(notIn: Set(open)) }
    }
    /// A card answered anywhere (here, in another app, by its deadline) leaves his notifications too.
    private func removeNotifications(notIn open: Set<String>) async {
        let center = UNUserNotificationCenter.current()
        let gone = await center.deliveredNotifications().filter {
            guard case .card(let pushId)? = NotificationRoute(userInfo: $0.request.content.userInfo) else {
                return false
            }
            return !open.contains(pushId)
        }
        center.removeDeliveredNotifications(withIdentifiers: gone.map(\.request.identifier))
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
        } catch _ where Task.isCancelled {
            // The screen that asked left: the read stands as it was.
            update(.failed(.cancelled))
        } catch let error as MCPError {
            if error == .notPaired { pairedOrigin = nil }
            update(.failed(error))
        } catch {
            update(.failed(.failed("Life's answer was not what this app reads.")))
        }
    }

    // MARK: Actions

    /// Runs one action under `key`: its events are applied in the order they came, and a second tap while it runs is ignored.
    private func perform(
        _ key: ActionKey, tap: String? = nil, _ body: @escaping @Sendable (@escaping LifeActions.Emit) async -> Void
    ) async {
        guard actions[key]?.isRunning != true else { return }
        let (events, emit) = AsyncStream.makeStream(of: ActionState<ActionProof>.Event.self)
        let began = now()
        var limit: Date?
        actions[key] = .running(steps: [], limit: nil)
        let consumer = Task {
            for await event in events {
                actions[key, default: .idle].apply(event)
                limit = actions[key]?.limit ?? limit
            }
        }
        await body { emit.yield($0) }
        emit.finish()
        await consumer.value
        if let ended = actions[key] { traceOf(key, tap: tap, ended, began: began, limit: limit) }
    }

    /// One `life.action` event per action that ended: what it was, how it ended, how long it took against its limit, and
    /// each step with the seconds it passed after the start. Ids, states and counts only; the kind of a lost connection, never its words.
    private func traceOf(
        _ key: ActionKey, tap: String?, _ ended: ActionState<ActionProof>, began: Date, limit: Date?
    ) {
        let finished = now()
        var fields = [
            "seconds": String(format: "%.1f", finished.timeIntervalSince(began)),
            "steps": ended.steps.map { step in
                "\(step.id)@" + (step.passedAt.map { String(format: "%.1f", $0.timeIntervalSince(began)) } ?? "-")
            }.joined(separator: ","),
        ]
        switch key {
        case .answer(let ref): fields["kind"] = "answer"; fields["ref"] = ref
        case .start(let matter): fields["kind"] = "start"; fields["ref"] = matter
        case .agent(let agent): fields["kind"] = "agent"; fields["ref"] = agent
        case .edit(let matter, let what): fields["kind"] = "edit.\(what)"; fields["ref"] = matter
        }
        if let tap { fields["key"] = String(tap.prefix(8)) }
        if let limit {
            fields["limit"] = String(format: "%.0f", limit.timeIntervalSince(began))
            fields["late"] = limit < finished ? "yes" : "no"
        }
        switch ended {
        case .succeeded: fields["outcome"] = "succeeded"
        case .failed(let failure, _):
            fields["outcome"] = "failed"
            fields["reason"] = failure.isSameTap ? failure.kind : failure.step ?? "-"
            fields["mayHaveHappened"] = failure.mayHaveHappened ? "yes" : "no"
        default: fields["outcome"] = "unfinished"
        }
        appEvent("life.action", fields)
    }

    /// His answer to a check. A call that failed on the connection is repeated as the same tap; a result Life gave
    /// (a send that was not sent included) makes the next tap a new one.
    func answer(_ request: AnswerRequest) async {
        let key = ActionKey.answer(ref: request.ref)
        guard actions[key]?.isRunning != true else { return }
        let tap = taps.key(for: request)
        await perform(key, tap: tap) { [runner] in await runner.answer(request, key: tap, emit: $0) }
        if let ended = actions[key] { taps.ended(request, as: ended) }
        await refreshInbox()
    }

    /// Starts an agent on a matter with the goal he saw, which Life saves as his: `goal_saved`, then the desk's stages.
    func startAgent(on id: String, goal: String, runtime: String? = nil, model: String? = nil) async {
        await perform(.start(matter: id)) { [runner] in
            await runner.startAgent(matter: id, goal: goal, runtime: runtime, model: model, emit: $0)
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
    private func change(_ agent: String, _ request: AgentRequest) async {
        await perform(.agent(agent)) { [runner] in await runner.changeAgent(request, emit: $0) }
        // The matter page draws the agent from its own read, so that read is refreshed too.
        let pages = matter.filter { $0.value.value?.agents.contains { $0.id == agent } == true }.keys
        async let agents: Void = refreshAgents()
        for id in pages { await refreshMatter(id) }
        await agents
    }

    /// His goal for a matter: Life pins it to the matter's steps.
    func setGoal(of id: String, _ goal: String) async {
        let api = api
        await edit(id, .goal) {
            try await api.setMatterDirection(matter: id, goal: goal, nextStep: nil, onProgress: $0)
        }
    }

    func setNextStep(of id: String, _ nextStep: NextStepRequest) async {
        let api = api
        await edit(id, .next) {
            try await api.setMatterDirection(matter: id, goal: nil, nextStep: nextStep, onProgress: $0)
        }
    }

    /// His word that the matter is done: Life decides what of it is open and closes it.
    func markDone(_ id: String) async {
        let api = api
        await edit(id, .done) {
            try await api.markDone(matter: id, note: "Marked done in the Life app.", onProgress: $0)
        }
    }

    private func edit(
        _ id: String, _ what: ActionKey.Edit,
        _ change: @escaping @Sendable (@escaping @Sendable (Data) -> Void) async throws -> String
    ) async {
        await perform(.edit(matter: id, what)) { [runner] in await runner.record(emit: $0, change) }
        async let a: Void = refreshMatter(id)
        async let b: Void = refreshMatters()
        _ = await (a, b)
    }

    /// A tapped push: the inbox is read again and the card with that `pushId` is the one opened; one that already
    /// left (answered elsewhere) opens the first card waiting, marked `wasAnswered`. Only a read that just succeeded can
    /// say so: offline, the cached inbox cannot hold the new card, and the read's own face shows instead.
    func open(pushId: String) async {
        await refreshInbox()
        guard inbox.phase == .loaded else { return }
        openedCard = inbox.value?.opening(pushId: pushId)
    }

    // MARK: Pairing

    /// Registers this app with Life, has the pairing code approve it, then reads everything as the first proof. The
    /// tokens are kept only once Life approved: a failed pairing leaves the old one working, and throws why.
    func pair(_ link: LifePairing, onStep: (PairStep) -> Void = { _ in }) async throws {
        onStep(.accepting)
        let credentials = try await approve(link)
        tokens.save(credentials)
        pairedOrigin = credentials.endpoint.origin
        // Another Life may be this one: nothing of the last one stays.
        cache.clear()
        (inbox, matters, matter, agents) = (ReadState(), ReadState(), [:], ReadState())
        onStep(.reading)
        await refresh()
    }

    #if DEBUG
        /// Development only: launch with `LIFE_ORIGIN` and `LIFE_PAIRING_CODE` in the environment (for example
        /// `SIMCTL_CHILD_LIFE_ORIGIN=… xcrun simctl launch …`) to pair with that Life, http too. Never in release builds.
        func importFromEnvironment() async {
            let environment = ProcessInfo.processInfo.environment
            guard !isPaired, let origin = environment["LIFE_ORIGIN"].flatMap(URL.init(string:)),
                let code = environment["LIFE_PAIRING_CODE"], !code.isEmpty
            else { return }
            try? await pair(LifePairing(origin: origin, code: code))
        }
    #endif
}
