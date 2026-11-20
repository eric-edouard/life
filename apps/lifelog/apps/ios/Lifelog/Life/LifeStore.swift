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
    /// A project's page: its matters with its head, by the project's id.
    private(set) var project: [String: ReadState<MatterList>] = [:]
    private(set) var agents = ReadState<RegisteredAgents>()
    /// Everyone the reads name, and their pictures.
    let parties: PartyBook

    /// What an action acts on: the store makes every key itself, so a screen asks for the state of what it shows.
    enum ActionKey: Hashable {
        case answer(ref: String)
        case start(matter: String)
        case agent(String)
        case edit(matter: String, Edit)
        case project(String)
        enum Edit: Hashable { case goal, next, done, important }
    }

    /// What his last mark or project status did, said back for four seconds (`Toast`), with its Undo (the opposite
    /// change), or why it was not done.
    struct SaidBack: Identifiable, Equatable {
        enum Undo: Equatable {
            case important(matter: String, Bool)
            case status(project: String, name: String, ProjectStatus, was: ProjectStatus)
        }
        let id = UUID()
        let words: String
        /// Nil when it was not done: the words say why.
        let undo: Undo?
    }
    private(set) var saidBack: SaidBack?
    /// His mark or a project's status from his tap until Life's reads say it: shown at once, one tap per item at a time.
    private let marking = PendingTaps<Bool>()
    private let statusing = PendingTaps<ProjectStatus>()

    /// Every action by what it acts on: its steps as they stream, then its proof or why not.
    private(set) var actions: [ActionKey: ActionState<ActionProof>] = [:]
    /// The card a tapped push opened, for the screen to show (`wasAnswered`: it had left the inbox).
    private(set) var openedCard: InboxOpening?
    /// A tapped push, from the tap until a whole read asked after it lands: its card, as in hand, is shown meanwhile.
    private(set) var pushed: PushedCard?

    /// Answers on rows of Life's own questions, held for Undo before they are sent (`HeldAnswers`).
    /// Its send ends with Life's answer, before the reads after it: a flush waits for Life, not for them.
    @ObservationIgnored private lazy var holds = HeldAnswers { [weak self] held in
        await self?.send(held.request, for: held.life)
        Task { await self?.refreshAfterAnswer() }
    }
    var held: [String: HeldAnswers.Held] { holds.held }
    /// Whether an answer is held or still being sent: the app going waits for it.
    var hasAnswersUnderWay: Bool { !holds.underWay.isEmpty }
    /// The answer held last, which the Inbox's toast names.
    var latestHeld: (ref: String, held: HeldAnswers.Held)? {
        holds.latest.flatMap { ref in holds.held[ref].map { (ref, $0) } }
    }
    /// The asks a read asked at `asked` (nil: none yet) may still list though his answer took them out: held for Undo, on
    /// their way, or confirmed after it was asked. Every screen leaves them out of that read (`inboxOnShow`, a matter's
    /// asks), so none flashes back; a read asked later says what is open.
    func answersNewer(than asked: Date?) -> Set<String> {
        holds.underWay.union(answered.newer(than: asked)).union(
            actions.compactMap { key, state in
                if case .answer(let ref) = key, state.isRunning { ref } else { nil }
            })
    }
    /// His answers Life confirmed, kept with the reads for a cold start.
    private var answered = AnsweredCards()
    /// Answers that have ended: a page that draws asks from its own read reads again when it changes.
    private(set) var answersEnded = 0

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
    /// One read of each kind at a time, plus one more pass.
    @ObservationIgnored private let flights = ReadFlights()
    /// The key of a tap whose call may have run (its connection failed): the same tap repeats with it, so Life sends nothing twice.
    private var taps = AnswerTaps()

    init(
        tokens: any TokenStore = LifeToken(), api: (any LifeAPI)? = nil,
        approve: @escaping Approve = { try await LifeOAuth().pair($0) },
        cache: ReadCache = ReadCache(directory: URL.applicationSupportDirectory.appending(path: "lifelog/life-reads")),
        pictures: URL = AppGroup.pictures,
        now: @escaping @Sendable () -> Date = { Date() },
        setBadge: @escaping @MainActor (Int) -> Void = { count in
            Task { try? await UNUserNotificationCenter.current().setBadgeCount(count) }
        }
    ) {
        self.tokens = tokens
        self.approve = approve
        let api = api ?? MCPLifeAPI(client: MCPClient(session: LifeSession(store: tokens)))
        self.api = api
        parties = PartyBook(pictures: PictureCache(directory: pictures, api: api), generation: PairingGeneration())
        runner = LifeActions(api: api, now: now)
        self.cache = cache
        self.now = now
        self.setBadge = setBadge
        pairedOrigin = tokens.load()?.endpoint.origin
        restore({ self.inbox.apply($0) }, key: Self.inboxKey)
        restore({ self.matters.apply($0) }, key: Self.mattersKey)
        restore({ self.agents.apply($0) }, key: Self.agentsKey)
        if let kept = cache.load(Self.answeredKey) {
            answered = (try? JSONDecoder().decode(AnsweredCards.self, from: Data(kept.text.utf8))) ?? answered
        }
        // No read is under way yet: an answer every kept read was asked after can show nowhere.
        answered.forget(confirmedBy: cache.oldest(except: Self.answeredKey))
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
        let before = inbox.loadedAt
        await load({ self.inbox.apply($0) }, key: Self.inboxKey) { try await $0.readInbox() }
        // A read asked after the tap ends its check: a card that was not in hand opens now, one answered elsewhere gives
        // way to the next with a notice. One he answered here since stays as he left it.
        if let push = pushed, inbox.loadedAt != before, let read = inbox.value, let asked = inbox.loadedAt,
            let opening = push.checked(by: read, askedAt: asked)
        {
            pushed = nil
            let isHis = push.check.map { answersNewer(than: push.tappedAt).contains($0.ref) } ?? false
            if push.check == nil || (opening.wasAnswered && !isHis) { openedCard = opening }
        }
        if inbox.value != nil { setBadge(badge) }
        // Only a whole read made just now says what is no longer open: not a cached, failed, cancelled or cut-off one.
        if inbox.loadedAt != before, let asked = inbox.loadedAt, let read = inbox.value, read.isWhole {
            let open = Set(read.checks.compactMap(\.pushId))
            await removeNotifications(deliveredBefore: asked) { !open.contains($0) }
        }
    }
    /// A card answered anywhere (here, in another app, by its deadline, withdrawn) leaves his notifications too: on a
    /// whole read, only one delivered before the read was asked (a card newer than the read is not in it), or on Life's
    /// push naming the cards that left (`NotificationRoute.removed`), which spares the result of his answer from a
    /// notification (`sparingResults`): every tap shows its result.
    func removeNotifications(
        deliveredBefore asked: Date = .distantFuture, sparingResults: Bool = false, where isGone: (String) -> Bool
    ) async {
        let center = UNUserNotificationCenter.current()
        let gone = await center.deliveredNotifications().filter {
            let info = $0.request.content.userInfo
            guard $0.date < asked, !(sparingResults && info[IncidentNotifier.resultKey] != nil),
                case .card(let pushId, _, _)? = NotificationRoute(userInfo: info)
            else {
                return false
            }
            return isGone(pushId)
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

    func refreshProject(_ id: String) async {
        let key = "read_matters-project-\(id)"
        let update = { (event: ReadState<MatterList>.Event) in self.project[id, default: ReadState()].apply(event) }
        if project[id] == nil { restore(update, key: key) }
        await load(update, key: key) { try await $0.readMatters(project: id) }
    }

    private static let inboxKey = "read_inbox"
    private static let mattersKey = "read_matters"
    private static let agentsKey = "read_registered_agents"
    private static let answeredKey = "answered_cards"

    /// His answer, confirmed: its card leaves every read asked before now, the badge with it, unless it keeps its card
    /// open or was begun under another pairing (`pairing`, its `PairingGeneration` when it began). Kept for a cold start.
    private func confirm(_ request: AnswerRequest, keepsCardOpen: Bool, pairing: Int) {
        guard !keepsCardOpen, pairing == parties.generation.current else { return }
        answered.answered(request.ref, at: now())
        if let data = try? JSONEncoder().encode(answered) {
            cache.store(String(decoding: data, as: UTF8.self), key: Self.answeredKey)
        }
        if inbox.value != nil { setBadge(badge) }
    }

    private func restore<V: Decodable & Sendable & NamesParties>(_ update: (ReadState<V>.Event) -> Void, key: String) {
        guard let kept = cache.load(key),
            let value = try? LibraryStore.feedDecoder.decode(V.self, from: Data(kept.text.utf8))
        else { return }
        parties.remember(value.parties, at: kept.at, pairing: parties.generation.current)
        update(.succeeded(value, kept.at))
    }

    /// The read `key`, one pass at a time (`ReadFlights`): its value applies as of when its pass began, and is kept for a
    /// cold start. A read of the Life paired before this one applies nothing, not even its failure: no save, no screen,
    /// no reset (`PairingGeneration`).
    private func load<V: Decodable & Sendable & NamesParties>(
        _ update: @escaping (ReadState<V>.Event) -> Void, key: String,
        fetch: @escaping @Sendable (any LifeAPI) async throws -> String
    ) async {
        await flights.run(key) { [self] in
            let (asked, pairing) = (now(), parties.generation.current)
            update(.started)
            guard let text = await parties.generation.answer({ try await fetch(api) }) else { return }
            do {
                let read = try text.get()
                let value = try LibraryStore.feedDecoder.decode(V.self, from: Data(read.utf8))
                cache.store(read, key: key, asked: asked)
                parties.remember(value.parties, at: asked, pairing: pairing)
                update(.succeeded(value, asked))
            } catch let error as MCPError {
                if error == .notPaired { pairedOrigin = nil }
                update(.failed(error))
            } catch {
                update(.failed(.failed("Life's answer was not what this app reads.")))
            }
        }
    }

    // MARK: Actions

    /// Runs one action under `key`: its events are applied in the order they came, and a second tap while it runs is
    /// ignored. `succeeded` runs in the step that applies its success, so no frame shows it neither running nor done.
    private func perform(
        _ key: ActionKey, tap: String? = nil, succeeded: @escaping () -> Void = {},
        _ body: @escaping @Sendable (@escaping LifeActions.Emit) async -> Void
    ) async {
        guard actions[key]?.isRunning != true else { return }
        let (events, emit) = AsyncStream.makeStream(of: ActionState<ActionProof>.Event.self)
        let began = now()
        var limit: Date?
        actions[key] = .running(steps: [], limit: nil)
        let consumer = Task {
            for await event in events {
                actions[key, default: .idle].apply(event)
                if case .succeeded = event { succeeded() }
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
        case .project(let id): fields["kind"] = "project"; fields["ref"] = id
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
    /// `keepsCardOpen`: Life keeps the card open after it (`Check.keepsOpen`).
    /// `life`: the Life it was decided for, when his tap was not on the screen now (a notification's button); else the
    /// one paired at this tap.
    func answer(_ request: AnswerRequest, keepsCardOpen: Bool = false, for life: PairedLife? = nil) async {
        await send(request, keepsCardOpen: keepsCardOpen, for: life ?? pairedLife)
        await refreshAfterAnswer()
    }

    /// The Life the phone is paired with now, as an answer decided now captures it (`PairedLife`).
    var pairedLife: PairedLife? {
        pairedOrigin.map { PairedLife(origin: $0, generation: parties.generation.current) }
    }

    /// The answer's call alone, until Life's answer to it, to the Life it was decided for (`life`) and no other: one
    /// decided under an earlier pairing, or none, is refused here and never sent.
    private func send(_ request: AnswerRequest, keepsCardOpen: Bool = false, for life: PairedLife?) async {
        let key = ActionKey.answer(ref: request.ref)
        guard actions[key]?.isRunning != true else { return }
        guard let life, life.generation == parties.generation.current else {
            return await perform(key) { emit in
                emit(.started)
                emit(.failed(ActionFailure(.notPaired)))
            }
        }
        let tap = taps.key(for: request)
        await perform(
            key, tap: tap, succeeded: { self.confirm(request, keepsCardOpen: keepsCardOpen, pairing: life.generation) }
        ) {
            [runner] in
            await runner.answer(request, key: tap, at: life.origin, emit: $0)
        }
        if let ended = actions[key] { taps.ended(request, as: ended) }
    }

    /// What an answer changes, read again: the inbox and the matters. The matter page on show reads itself again when `answersEnded` changes.
    private func refreshAfterAnswer() async {
        answersEnded += 1
        async let inbox: Void = refreshInbox()
        async let matters: Void = refreshMatters()
        _ = await (inbox, matters)
    }

    // MARK: Held answers

    /// His answer to such a row, sent in four seconds unless he undoes it.
    func hold(_ request: AnswerRequest, as label: String) { holds.hold(request, as: label, for: pairedLife) }

    func undo(_ ref: String) { holds.undo(ref) }

    /// Every held answer, at once: the screen is going, or the app.
    func sendHeld() async { await holds.sendAll() }

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

    // MARK: His mark, a project's status

    /// Whether a matter is marked, his tap first.
    func isImportant(_ id: String, as read: Bool?) -> Bool { marking[id] ?? (read == true) }

    /// A project's status as stored, his tap first.
    func status(of id: String, as read: ProjectStatus) -> ProjectStatus { statusing[id] ?? read }

    /// His mark on a matter, on or off, said back with Undo (the opposite mark, said back by nothing) once every read
    /// that shows it (the matter, the list, the Inbox's flags and order) is read again.
    func setImportant(_ id: String, _ isOn: Bool, saysBack: Bool = true) async {
        let api = api
        let key = ActionKey.edit(matter: id, .important)
        let isSent = await marking.run(id, showing: isOn) {
            await perform(key) { [runner] in
                await runner.record(emit: $0) { try await api.setImportant(matter: id, isOn, onProgress: $0) }
            }
            async let a: Void = refreshMatter(id)
            async let b: Void = refreshMatters()
            async let c: Void = refreshInbox()
            _ = await (a, b, c)
        }
        guard isSent else { return }
        say(key, saysBack ? (isOn ? "Important" : "Not important") : nil, undo: .important(matter: id, !isOn))
    }

    /// A project's status by his tap: `words` say it back with Undo (the status it had, said back by nothing) once its
    /// reads are read again.
    func setStatus(of id: String, named name: String, to status: ProjectStatus, was: ProjectStatus, words: String?)
        async
    {
        let api = api
        let said =
            switch status {
            case .parked: "Parked the project \(name)"
            case .done: "Marked the project \(name) done"
            case .waiting: "Set the project \(name) back to waiting"
            default: "Set the project \(name) underway"
            }
        let isSent = await statusing.run(id, showing: status) {
            await perform(.project(id)) { [runner] in
                await runner.record(emit: $0) { try await api.setProjectStatus(id, status, said: said, onProgress: $0) }
            }
            async let a: Void = refreshProject(id)
            async let b: Void = refreshMatters()
            _ = await (a, b)
        }
        guard isSent else { return }
        say(.project(id), words, undo: .status(project: id, name: name, was, was: status))
    }

    /// Its Undo as a tap, none when it was not done.
    func undoing(_ said: SaidBack) -> (() -> Void)? {
        said.undo == nil ? nil : { Task { await self.undo(said) } }
    }

    func undo(_ said: SaidBack) async {
        saidBack = nil
        switch said.undo {
        case .important(let id, let isOn)?: await setImportant(id, isOn, saysBack: false)
        case .status(let id, let name, let status, let was)?:
            await setStatus(of: id, named: name, to: status, was: was, words: nil)
        case nil: break
        }
    }

    /// Says back how `key` ended: `words` with Undo when done, its reason when not (always), then nothing after 4 s.
    private func say(_ key: ActionKey, _ words: String?, undo: SaidBack.Undo) {
        let said: SaidBack? =
            switch state(of: key) {
            case .succeeded: words.map { SaidBack(words: $0, undo: undo) }
            case .failed(let failure, _): SaidBack(words: failure.reason, undo: nil)
            default: nil
            }
        guard let said else { return }
        saidBack = said
        Task {
            try? await Task.sleep(for: .seconds(4))
            if saidBack?.id == said.id { saidBack = nil }
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

    /// A matter's asks less those his answers took out since it was read: the Inbox's rule (`answersNewer`), for its
    /// page's rows and the ask pushed from them alike.
    func asks(ofMatter id: String) -> [Check] {
        let read = matter[id]
        let answered = answersNewer(than: read?.loadedAt)
        return read?.value?.checks.filter { !answered.contains($0.ref) } ?? []
    }

    /// A tapped push: its card, from the cached inbox or else the one its notification kept (`card`), is on show at once,
    /// its answers live, while one whole read checks it (`pushed`, `refreshInbox`). The notification's card counts only
    /// when it is this push's and was read from the Life paired now (`life`). With neither in hand (an older
    /// notification, a card past what was read), Life's read of its pushId opens it beside the whole read.
    func open(pushId: String, card: String? = nil, life: String? = nil) async {
        let kept = CardNotification.check(card, pushId: pushId, life: life, pairedWith: pairedOrigin)
        let push = PushedCard(pushId: pushId, in: inbox.value, notified: kept, at: now())
        pushed = push
        openedCard = push.opening
        guard push.check == nil else { return await refreshInbox() }
        async let whole: Void = refreshInbox()
        if let found = await notifiedCard(pushId: pushId, kept: nil, life: nil), pushed == push {
            pushed = PushedCard(pushId: pushId, in: nil, notified: found.check, at: push.tappedAt)
            openedCard = pushed?.opening
        }
        await whole
    }

    /// The card a notification names, as the Life paired now has it (`CardNotification.card`): every answer from a
    /// notification's button asks it first, so none reaches another Life's card.
    func notifiedCard(pushId: String, kept: String?, life: String?) async -> (check: Check, life: PairedLife)? {
        guard let paired = pairedLife,
            let check = await CardNotification.card(
                pushId: pushId, kept: kept, life: life, pairedWith: paired.origin,
                readPush: { [api] in try await api.readInbox(pushId: pushId, at: $0) })
        else { return nil }
        return (check, paired)
    }

    /// A read is checking the tapped push: the card's pager waits on it. A failed read shows the card as stale instead.
    var isCheckingPush: Bool { pushed != nil && inbox.phase == .loading }

    /// What the Inbox shows: the inbox read, with a tapped push's card in hand (`PushedCard`), less the asks his answers
    /// took out (`answersNewer`). The card in hand shows even before anything was read, with the read's own faces.
    var inboxShown: ReadState<Inbox>.Shown {
        readOnShow.shown(isEmpty: { $0.without(answersNewer(than: inbox.loadedAt)).checks.isEmpty })
    }
    var inboxOnShow: Inbox? { readOnShow.value?.without(answersNewer(than: inbox.loadedAt)) }
    private var readOnShow: ReadState<Inbox> {
        guard let pushed,
            let shown = pushed.shown(in: inbox.value, answeredSinceTap: answersNewer(than: pushed.tappedAt))
        else { return inbox }
        return inbox.showing(shown, at: pushed.tappedAt)
    }
    /// The asks that block him, less those he answered: the tab's badge and the app's.
    var badge: Int { inbox.value?.without(answersNewer(than: inbox.loadedAt)).badge ?? 0 }

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
        (inbox, matters, matter, agents, project) = (ReadState(), ReadState(), [:], ReadState(), [:])
        (answered, pushed) = (AnsweredCards(), nil)
        parties.startOver()
        holds.clear()
        onStep(.reading)
        await refresh()
    }

    #if DEBUG
        /// Development only (`-fixtureCard`): opens the card with that ref as a tapped push does.
        func open(ref: String) async {
            guard let pushId = inbox.value?.checks.first(where: { $0.ref == ref })?.pushId else { return }
            await open(pushId: pushId)
        }

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

extension LifeStore {
    /// The program of the agent that asks a check (`Check.askingRuntime`).
    func runtimeName(of check: Check) -> RuntimeName? { agents.value.flatMap { check.askingRuntime(among: $0.agents) } }
}
