import Foundation
import Incidents
import Library
import LifeConnector
import Observation
import SwiftUI
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
    /// The Projects tab: its chips, a project chip's header by the project's id, and a chip's matters by its identity.
    private(set) var projects = ReadState<ProjectChips>()
    private(set) var projectHead: [String: ReadState<ProjectHeader>] = [:]
    private(set) var scopedMatters: [String: ReadState<MatterList>] = [:]
    private(set) var agents = ReadState<RegisteredAgents>()
    /// What Life costs this month (Settings, Spending): read when the page opens, kept for a cold start.
    private(set) var spending = ReadState<ModelSpending>()
    /// The People tab: everyone Life knows, closest first; one of them read in full, by ref; and what a search found.
    private(set) var people = ReadState<PeopleList>()
    private(set) var person: [String: ReadState<PersonNow>] = [:]
    private(set) var peopleFound: (query: String, state: ReadState<PeopleList>)?
    /// A person's page's parts, by their ref: a page of their latest exchanges, a part of prose.
    private(set) var latest: [String: ReadState<LatestPage>] = [:]
    private(set) var prose: [String: ReadState<Prose>] = [:]
    /// The pages of someone's `reach` part, by their ref: every account, when `now` had no room for them all.
    private(set) var reach: [String: ReadState<ReachPage>] = [:]
    /// Every matter open with someone, by their ref: read on All once their `now` left some out.
    private(set) var openWith: [String: ReadState<MatterList>] = [:]
    /// Everyone the reads name, and their pictures.
    let parties: PartyBook

    /// What an action acts on: the store makes every key itself, so a screen asks for the state of what it shows.
    nonisolated enum ActionKey: Hashable, Sendable {
        case answer(ref: String)
        case start(matter: String)
        case agent(String)
        /// His move of a matter, or his runtime switch of an agent, by the matter's or the agent's id.
        case move(String)
        case edit(matter: String, Edit)
        case project(String)
        /// His Remove or Undo of an appointment Life added to his calendar, by its id.
        case appointment(String)
        enum Edit: Hashable { case goal, next, done, important, icon }
    }

    /// What his last mark, project status or matter icon did, said back for four seconds (`Toast`), with its Undo (the
    /// opposite change), or why it was not done.
    struct SaidBack: Identifiable, Equatable {
        enum Undo: Equatable {
            case important(matter: String, Bool)
            /// His icon to put back (nil: Life's pick), and the one it replaces.
            case icon(matter: String, String?, was: String?)
            case status(project: String, name: String, ProjectStatus, was: ProjectStatus)
        }
        let id = UUID()
        let words: String
        /// Nil when it was not done (the words say why), or when it has no Undo.
        let undo: Undo?
        /// Done (its glyph a tick) or not (a flag).
        let isDone: Bool
    }
    private(set) var saidBack: SaidBack?
    /// His mark or a project's status from his tap until Life's reads say it: shown at once, one tap per item at a time.
    private let marking = PendingTaps<Bool>()
    private let statusing = PendingTaps<ProjectStatus>()
    /// His icon pick on a matter (a key, or nil: Life picks again) from his tap until Life's reads after it.
    private let iconing = PendingTaps<String?>()
    /// His icon picks Life took, until a read of the matter shows them.
    private var writtenIcons = WrittenIcons()

    /// Every action by what it acts on: its steps as they stream, then its proof or why not.
    private(set) var actions = ActionBook<ActionKey>()
    /// The card a tapped push opened, for the screen to show (`wasAnswered`: it had left the inbox).
    private(set) var openedCard: InboxOpening?
    /// A tapped push, from the tap until a whole read asked after it lands: its card, as in hand, is shown meanwhile.
    private(set) var pushed: PushedCard?

    /// Answers on rows of Life's own questions, held for Undo before they are sent (`HeldAnswers`).
    /// Its send ends with Life's answer, before the reads after it: a flush waits for Life, not for them.
    @ObservationIgnored private lazy var holds = HeldAnswers { [weak self] held in
        let matter = self?.heldMatters.removeValue(forKey: held.request.ref) ?? nil
        await self?.send(held.request, for: held.life)
        // Its card is gone by now: what Life did or could not do on it, or when it comes back, is said back here.
        if let said = self?.state(of: .answer(ref: held.request.ref)).heldAnswerWords(as: held.label) {
            self?.show(SaidBack(words: said.words, undo: nil, isDone: said.isDone))
        }
        Task { await self?.refreshAfterAnswer(on: matter) }
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
            actions.states.compactMap { key, state in
                if case .answer(let ref) = key, state.isRunning { ref } else { nil }
            })
    }
    /// His answers Life confirmed, kept with the reads for a cold start.
    private var answered = AnsweredCards()
    /// Answers that have ended, by the matter of their card: its page, which draws asks from its own read, and the
    /// project chip on show read again when it changes. An answer on a card of no matter changes no matter.
    private(set) var answersEnded: [String: Int] = [:]

    /// His moves Life answered, by the matter or agent moved, until the reads show them ended (`settleMoves`).
    var moveReceipts: [String: MoveReceipt] = [:]
    /// The moves he asked from this phone (their ids): Try again repeats only one of them.
    var movesAskedHere: Set<String> = []

    /// The Life this phone is paired with: set by a pairing, gone once Life no longer knows it (a read says so).
    private(set) var pairedOrigin: URL?

    /// Registers with Life and has the pairing code approve it (`LifeOAuth`); a test or a fixture gives its own.
    typealias Approve = @Sendable (LifePairing) async throws -> LifeCredentials

    private let tokens: any TokenStore
    private let approve: Approve
    private let api: any LifeAPI
    private let cache: ReadCache
    let runner: LifeActions
    /// Tell Life: his one conversation with Life's main session.
    let tell: TellLife
    let now: @Sendable () -> Date
    private let setBadge: @MainActor (Int) -> Void
    /// The phone's network path, which the pendant's sync follows too.
    private let path: NetworkPath
    /// How the newest settled read of Life ended: with the path, whether Life can be reached (`whyOutOfReach`).
    /// Kept out of observation (its `asked` moves on every read); `lost` is the part a screen watches, set only when it changes.
    @ObservationIgnored private var connection = LifeConnection()
    private var lost: MCPError?
    /// One read of each kind at a time, plus one more pass.
    @ObservationIgnored private let flights: ReadFlights
    /// The key of a tap whose call may have run (its connection failed): the same tap repeats with it, so Life sends nothing twice.
    private var taps = AnswerTaps()

    init(
        tokens: any TokenStore = LifeToken(), api: (any LifeAPI)? = nil,
        approve: @escaping Approve = { try await LifeOAuth().pair($0) },
        cache: ReadCache = ReadCache(directory: URL.applicationSupportDirectory.appending(path: "lifelog/life-reads")),
        pictures: URL = AppGroup.pictures,
        now: @escaping @Sendable () -> Date = { Date() },
        path: NetworkPath,
        setBadge: @escaping @MainActor (Int) -> Void = { count in
            Task { try? await UNUserNotificationCenter.current().setBadgeCount(count) }
        }
    ) {
        self.tokens = tokens
        self.approve = approve
        let api = api ?? MCPLifeAPI(client: MCPClient(session: LifeSession(store: tokens)))
        self.api = api
        parties = PartyBook(pictures: PictureCache(directory: pictures, api: api), generation: PairingGeneration())
        flights = ReadFlights(generation: parties.generation)
        runner = LifeActions(api: api, now: now)
        tell = TellLife(api: api)
        self.cache = cache
        self.now = now
        self.setBadge = setBadge
        self.path = path
        pairedOrigin = tokens.load()?.endpoint.origin
        restore({ self.inbox.apply($0) }, key: Self.inboxKey)
        restore({ self.matters.apply($0) }, key: Self.mattersKey)
        restore({ self.agents.apply($0) }, key: Self.agentsKey)
        restore({ self.projects.apply($0) }, key: Self.projectsKey)
        restore({ self.people.apply($0) }, key: Self.peopleKey)
        if let kept = cache.load(Self.answeredKey) {
            answered = (try? JSONDecoder().decode(AnsweredCards.self, from: Data(kept.text.utf8))) ?? answered
        }
        // No read is under way yet: an answer every kept read was asked after can show nowhere.
        answered.forget(confirmedBy: cache.oldest(except: Self.answeredKey))
    }

    var isPaired: Bool { pairedOrigin != nil }
    /// Whether the phone has a network path at all; back, every read screen reads again.
    var hasPath: Bool { path.network != .none }
    /// Why Life cannot be reached now (no internet, or the newest read found the Mac out of reach), nil when it can. While
    /// it is not nil the app is read-only: no tap on a screen acts (`refusedOutOfReach`), its controls are off, and every
    /// read screen says why.
    var whyOutOfReach: String? {
        _ = lost  // the observed part of `connection`
        return connection.whyNot(hasPath: hasPath)
    }
    var isOutOfReach: Bool { whyOutOfReach != nil }
    /// Whether Life answers: its inbox read, the one every screen starts from.
    var link: LinkState { outcome.link(hasRead: inbox.value != nil) }

    func state(of key: ActionKey) -> ActionState<ActionProof> { actions[key] ?? .idle }

    /// Forgets an action's result once the screen has shown it (the next card is up, the sheet is closed).
    func forget(_ key: ActionKey) {
        actions.forget(key)
    }

    /// The card a tapped push opened has been shown.
    func clearOpenedCard() { openedCard = nil }

    // MARK: Reads

    /// Coming forward: every read, unless the inbox was read in the last 30 s (a card's push says what changed since).
    func refreshOnForeground() async {
        if let read = inbox.loadedAt, now().timeIntervalSince(read) < Self.foregroundReadsAfter { return }
        await refresh()
    }

    /// How old the inbox's read must be for coming forward to read again.
    private static let foregroundReadsAfter: TimeInterval = 30

    /// Every read, side by side.
    func refresh() async {
        async let a: Void = refreshInbox()
        async let b: Void = refreshMatters()
        async let c: Void = refreshAgents()
        async let d: Void = refreshProjects()
        _ = await (a, b, c, d)
    }

    /// Whether a first read of the inbox, matters, agents or chips is still missing and worth trying again.
    var needsRetry: Bool { inbox.needsRetry || matters.needsRetry || agents.needsRetry || projects.needsRetry }

    /// Reads again only what has nothing to show yet.
    func retryFirstReads() async {
        async let a: Void = inbox.needsRetry ? refreshInbox() : ()
        async let b: Void = matters.needsRetry ? refreshMatters() : ()
        async let c: Void = agents.needsRetry ? refreshAgents() : ()
        async let d: Void = projects.needsRetry ? refreshProjects() : ()
        _ = await (a, b, c, d)
    }

    func refreshInbox() async {
        let before = inbox.loadedAt
        await load({ self.inbox.apply($0) }, key: Self.inboxKey, held: { self.inbox.value }) {
            try await $0.readInbox(ifNot: $1)
        }
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
            await Self.removeNotifications(deliveredBefore: asked) { !open.contains($0) }
        }
    }
    /// A card answered anywhere (here, in another app, by its deadline, withdrawn) leaves his notifications too: on a
    /// whole read, only one delivered before the read was asked (a card newer than the read is not in it), or on Life's
    /// push naming the cards that left (`NotificationRoute.removed`), which spares the result of his answer from a
    /// notification (`sparingResults`): every tap shows its result.
    /// Off the main actor: the notification center's calls are synchronous IPC (`IncidentNotifier.remove`).
    @concurrent nonisolated static func removeNotifications(
        deliveredBefore asked: Date = .distantFuture, sparingResults: Bool = false,
        where isGone: @Sendable (String) -> Bool
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
        await load({ self.matters.apply($0) }, key: Self.mattersKey, held: { self.matters.value }) {
            try await $0.readMatters(ifNot: $1)
        }
    }
    func refreshAgents() async {
        let before = agents.loadedAt
        await load({ self.agents.apply($0) }, key: Self.agentsKey) { try await $0.readRegisteredAgents() }
        // Only a fresh read settles his moves, never the cached one a failed read leaves.
        if agents.loadedAt != before { settleMoves() }
    }

    func refreshSpending() async {
        if spending.phase == .idle { restore({ self.spending.apply($0) }, key: Self.spendingKey) }
        await load({ self.spending.apply($0) }, key: Self.spendingKey) { try await $0.readSpending() }
    }

    func refreshPeople() async {
        await load({ self.people.apply($0) }, key: Self.peopleKey) {
            try await $0.readPeopleAndOrganizations(query: nil)
        }
    }

    func refreshPerson(_ ref: String) async {
        let key = "read_people_and_organizations-\(ref)"
        let update = { (event: ReadState<PersonNow>.Event) in self.person[ref, default: ReadState()].apply(event) }
        if person[ref] == nil { restore(update, key: key) }
        await load(update, key: key) { try await $0.readPart(ref + "/now") }
    }

    func refreshLatest(_ ref: String) async {
        await load({ self.latest[ref, default: ReadState()].apply($0) }, key: ref, isKept: false) {
            try await $0.readPart(ref)
        }
    }

    /// Every account of theirs: the `reach` part page after page to its end, from `first` on a visit (the accounts may
    /// have changed on the Mac since), or from the page that failed on Try again (`isRetry`). A page that fails stops
    /// it there; the pages read before stand until their new read lands.
    func refreshReach(from first: String, isRetry: Bool = false) async {
        var next = isRetry ? reachChain(from: first).toRead : first
        while let ref = next {
            await load({ self.reach[ref, default: ReadState()].apply($0) }, key: ref, isKept: false) {
                try await $0.readPart(ref)
            }
            guard reach[ref]?.phase == .loaded else { return }
            next = reach[ref]?.value?.next
        }
    }

    /// The `reach` part's pages read so far, from `first`, and what comes next.
    func reachChain(from first: String) -> PageChain<ReachPage> {
        PageChain(from: first, states: reach, next: \.next)
    }

    /// Their `latest` pages read so far, from the first, paging back, and what comes next.
    func latestChain(of subject: String) -> PageChain<LatestPage> {
        PageChain(from: subject + "/latest", states: latest) { $0.earlier(of: subject) }
    }

    func refreshOpenWith(_ ref: String) async {
        await load(
            { self.openWith[ref, default: ReadState()].apply($0) }, key: "read_matters-person-\(ref)", isKept: false
        ) {
            try await $0.readMatters(person: ref)
        }
    }

    func refreshProse(_ ref: String) async {
        await load({ self.prose[ref, default: ReadState()].apply($0) }, key: ref, isKept: false) {
            try await $0.readPart(ref)
        }
    }

    /// A `life:` link's page (`fetch`): read when opened, kept by the page that shows it.
    func fetch(_ ref: String, _ update: (ReadState<LifeLinkRead>.Event) -> Void) async {
        update(.started)
        guard let event = await LifeLinkRead.read(ref, api: api, generation: parties.generation, now: now) else {
            return
        }
        if case .failed(.notPaired) = event { pairedOrigin = nil }
        update(event)
    }

    /// An appointment Life added to his calendar (`read_appointments`): read when its sheet opens, kept by the sheet.
    func readAppointment(_ key: AppointmentKey, _ update: @escaping (ReadState<Appointment>.Event) -> Void) async {
        await load(update, key: "read_appointments-\(key.id)", isKept: false) {
            try await $0.readAppointment(key, at: nil)
        }
    }

    /// His Remove (`isOn` false) or Undo of one, from its sheet or its notification: Life's `failed` fails it, with
    /// Life's reason.
    @discardableResult
    func changeAppointment(_ id: String, isOn: Bool) async -> ActionState<ActionProof> {
        let api = api
        await perform(.appointment(id)) { [runner] in
            await runner.record(emit: $0) { _ in
                let text = try await api.changeAppointment(id, isOn: isOn, at: nil)
                try AppointmentChange.checked(text, isOn: isOn)
                return text
            }
        }
        return state(of: .appointment(id))
    }

    /// The people and organizations `query` matches, and the others Life has seen by that name; a newer query's read
    /// replaces this one's, which then applies nothing.
    func findPeople(_ query: String) async {
        if peopleFound?.query != query { peopleFound = (query, ReadState()) }
        await load(
            { if self.peopleFound?.query == query { self.peopleFound?.state.apply($0) } },
            key: "read_people_and_organizations-query-\(query)", isKept: false
        ) {
            try await $0.readPeopleAndOrganizations(query: query)
        }
    }

    /// A page of Life's log (`read_log_lines`), for the Live logs page, which keeps it: never cached (an old log read
    /// as live would lie). Nil when another pairing began meanwhile: it applies nothing.
    func readLogLines(_ query: LogQuery) async -> Result<LogPage, MCPError>? {
        guard let answer = await parties.generation.answer({ try await api.readLogLines(query) }) else { return nil }
        do {
            return .success(try LibraryStore.feedDecoder.decode(LogPage.self, from: Data(answer.get().utf8)))
        } catch {
            let error =
                error is DecodingError ? .failed("Life's answer was not what this app reads.") : MCPError.of(error)
            if error == .notPaired { pairedOrigin = nil }
            return .failure(error)
        }
    }

    func refreshMatter(_ id: String) async {
        let key = "read_matter-\(id)"
        let update = { (event: ReadState<Matter>.Event) in self.matter[id, default: ReadState()].apply(event) }
        // Offline, a matter not read yet since launch still shows what was last read, as stale.
        if matter[id] == nil { restore(update, key: key) }
        let before = matter[id]?.loadedAt
        await load(update, key: key) {
            try await $0.readMatter(id)
        }
        if matter[id]?.loadedAt != before { settleMoves(matterRead: id) }
    }

    func refreshProjects() async {
        await load({ self.projects.apply($0) }, key: Self.projectsKey, held: { self.projects.value }) {
            try await $0.readProjects(ifNot: $1)
        }
    }

    func refreshProjectHead(_ id: String) async {
        let key = "read_project-\(id)"
        let update = { (event: ReadState<ProjectHeader>.Event) in
            self.projectHead[id, default: ReadState()].apply(event)
        }
        if projectHead[id] == nil { restore(update, key: key) }
        await load(update, key: key, held: { self.projectHead[id]?.value }) { try await $0.readProject(id, ifNot: $1) }
    }

    /// A chip's list: a project's matters, or an area's in no project (Life's one rule for both, `isInScope`).
    func refreshScopedMatters(_ kind: ProjectChips.Chip.Kind, _ id: String) async {
        let chip = ProjectChips.Chip.identity(kind, id)
        let key = "read_matters-\(chip)"
        let update = { (event: ReadState<MatterList>.Event) in
            self.scopedMatters[chip, default: ReadState()].apply(event)
        }
        if scopedMatters[chip] == nil { restore(update, key: key) }
        await load(update, key: key, held: { self.scopedMatters[chip]?.value }) {
            try await kind == .area ? $0.readMatters(area: id, ifNot: $1) : $0.readMatters(project: id, ifNot: $1)
        }
    }

    private static let inboxKey = "read_inbox"
    private static let mattersKey = "read_matters"
    private static let agentsKey = "read_registered_agents"
    private static let projectsKey = "read_projects"
    private static let peopleKey = "read_people_and_organizations"
    private static let spendingKey = "read_spending"
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

    private func restore<V: ParsedRead & NamesParties>(_ update: (ReadState<V>.Event) -> Void, key: String) {
        guard let kept = cache.load(key),
            let value = try? V.parsed(kept.text)
        else { return }
        parties.remember(value.parties, at: kept.at, pairing: parties.generation.current)
        update(.succeeded(value, kept.at))
    }

    /// The read `key`, one pass at a time (`ReadFlights`): its value applies as of when its pass began, and is kept for a
    /// cold start unless `isKept` is false (a part of a page, read again on each visit). A read of the Life paired before this one applies nothing, not even its failure: no save, no screen,
    /// no reset (`PairingGeneration`).
    private func load<V: ParsedRead & NamesParties>(
        _ update: @escaping (ReadState<V>.Event) -> Void, key: String, isKept: Bool = true,
        fetch: @escaping @Sendable (any LifeAPI) async throws -> String
    ) async {
        await load(update, key: key, isKept: isKept, held: { nil }) { api, _ in try await fetch(api) }
    }

    /// A versioned read (`VersionedRead`) is asked `ifNot` the version of the value `held` as its pass begins: while
    /// Life says nothing changed, that value holds, read as of now, and its kept copy stays as it is.
    private func load<V: ParsedRead & NamesParties>(
        _ update: @escaping (ReadState<V>.Event) -> Void, key: String, isKept: Bool = true, held: @escaping () -> V?,
        fetch: @escaping @Sendable (any LifeAPI, _ ifNot: String?) async throws -> String
    ) async {
        await flights.run(key) { [self] in
            let (asked, pairing, held) = (now(), parties.generation.current, held())
            let versioned = held as? any VersionedRead
            let ifNot = versioned?.version
            // Every read says whether Life could be reached (`whyOutOfReach`).
            let apply = { (event: ReadState<V>.Event) in
                self.connection.note(event, asked: asked)
                if self.lost != self.connection.lost { self.lost = self.connection.lost }
                update(event)
            }
            apply(.started)
            guard let text = await parties.generation.answer({ try await fetch(api, ifNot) }) else { return }
            do {
                let read = try text.get()
                if let held, versioned?.isUnchanged(by: read) == true { return apply(.succeeded(held, asked)) }
                let kept = isKept ? cache : nil
                let value = try await Self.parsed(read, as: V.self, keptIn: kept, key: key, asked: asked)
                // Another Life paired while it was decoded: nothing of this one applies.
                guard pairing == parties.generation.current else { return }
                parties.remember(value.parties, at: asked, pairing: pairing)
                apply(.succeeded(value, asked))
            } catch let error as MCPError {
                if error == .notPaired { pairedOrigin = nil }
                apply(.failed(error))
            } catch {
                apply(.failed(.failed("Life's answer was not what this app reads.")))
            }
        }
    }

    /// A read's text decoded, and kept for a cold start (`cache`), off the main actor: a large inbox costs frames there.
    @concurrent private nonisolated static func parsed<V: ParsedRead>(
        _ text: String, as: V.Type, keptIn cache: ReadCache?, key: String, asked: Date
    ) async throws -> V {
        let value = try V.parsed(text)
        cache?.store(text, key: key, asked: asked)
        return value
    }

    // MARK: Actions

    /// Runs one action under `key`: its events are applied in the order they came, and a second tap while it runs is
    /// ignored. `succeeded` runs in the step that applies its success, so no frame shows it neither running nor done.
    func perform(
        _ key: ActionKey, tap: String? = nil, succeeded: @escaping () -> Void = {},
        _ body: @escaping @Sendable (@escaping LifeActions.Emit) async -> Void
    ) async {
        guard actions.begin(key) else { return }
        let (events, emit) = AsyncStream.makeStream(of: ActionState<ActionProof>.Event.self)
        let (began, pairing) = (now(), actions.pairing)
        var limit: Date?
        let consumer = Task {
            // Applied only within its pairing: after another, its key may be a new tap's, on that Life's card.
            for await event in events {
                guard actions.apply(event, to: key, begunIn: pairing) else { continue }
                if case .succeeded = event { succeeded() }
                limit = actions[key]?.limit ?? limit
            }
        }
        await body { emit.yield($0) }
        emit.finish()
        await consumer.value
        guard pairing == actions.pairing else { return }
        if let ended = actions[key] { traceAction(key, tap: tap, ended, began: began, finished: now(), limit: limit) }
    }

    /// His answer to a check. A call that failed on the connection is repeated as the same tap; a result Life gave
    /// (a send that was not sent included) makes the next tap a new one.
    /// `keepsCardOpen`: Life keeps the card open after it (`Check.keepsOpen`).
    /// `life`: the Life it was decided for, when his tap was not on the screen now (a notification's button); else the
    /// one paired at this tap.
    func answer(_ request: AnswerRequest, keepsCardOpen: Bool = false, for life: PairedLife? = nil) async {
        if life == nil, await refusedOutOfReach(.answer(ref: request.ref)) { return }
        let matter = matterOf(card: request.ref)
        await send(request, keepsCardOpen: keepsCardOpen, for: life ?? pairedLife)
        await refreshAfterAnswer(on: matter)
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
        guard let life, life.generation == parties.generation.current else { return await refuseUnpaired(key) }
        let (tap, generation) = (taps.key(for: request), parties.generation)
        await perform(
            key, tap: tap, succeeded: { self.confirm(request, keepsCardOpen: keepsCardOpen, pairing: life.generation) }
        ) {
            [runner] in
            await runner.answer(
                request, key: tap, at: life.origin, whilePaired: { generation.current == life.generation }, emit: $0)
        }
        if life.generation == actions.pairing, let ended = actions[key] { taps.ended(request, as: ended) }
    }

    /// An action with no Life to go to: refused before anything leaves the phone, as not paired.
    private func refuseUnpaired(_ key: ActionKey) async {
        await perform(key) { emit in
            emit(.started)
            emit(.failed(ActionFailure(.notPaired)))
        }
    }

    /// The matter of the card `ref`, as the inbox or a matter's read on hand has it; nil when it has none.
    private func matterOf(card ref: String) -> String? {
        if let check = inbox.value?.checks.first(where: { $0.ref == ref }) { return check.matter?.id }
        return matter.first { $0.value.value?.checks.contains { $0.ref == ref } == true }?.key
    }

    /// What an answer changes, read again: the inbox; with a card of a matter, the matters and the chips too. That
    /// matter's page, and the header and list of the chip on show, read themselves again when `answersEnded` changes.
    private func refreshAfterAnswer(on matter: String?) async {
        guard let matter else { return await refreshInbox() }
        answersEnded[matter, default: 0] += 1
        async let inbox: Void = refreshInbox()
        async let matters: Void = refreshMatters()
        async let chips: Void = refreshProjects()
        _ = await (inbox, matters, chips)
    }

    // MARK: Held answers

    /// His answer to such a row, sent in four seconds unless he undoes it; none while Life is out of reach.
    func hold(_ request: AnswerRequest, as label: String) {
        guard !isOutOfReach else { return }
        heldMatters[request.ref] = matterOf(card: request.ref)
        holds.hold(request, as: label, for: pairedLife)
    }

    /// A tap that would hold or leave its ask, while Life is out of reach: why, said back, and true; it does nothing.
    func saysOutOfReach() -> Bool {
        guard let why = whyOutOfReach else { return false }
        show(SaidBack(words: why, undo: nil, isDone: false))
        return true
    }

    /// A tap on a screen while Life is out of reach: refused before anything leaves the phone or shows, with why. Only
    /// taps on a screen: an answer from a notification's button, or one held before Life went out of reach, is tried.
    /// `saysBack`: an action said back with Undo (`saidBack`) says why there too.
    func refusedOutOfReach(_ key: ActionKey, saysBack: Bool = false) async -> Bool {
        guard let why = whyOutOfReach else { return false }
        await perform(key) { emit in
            emit(.started)
            emit(.failed(ActionFailure(reason: why, retry: .allowed)))
        }
        if saysBack { _ = saysOutOfReach() }
        return true
    }

    /// A bulk card's answers, held as one: one toast, one Undo; none while Life is out of reach.
    func hold(_ requests: [AnswerRequest], as label: String) {
        guard !isOutOfReach else { return }
        for request in requests { heldMatters[request.ref] = matterOf(card: request.ref) }
        holds.hold(requests, as: label, for: pairedLife)
    }

    /// Each held answer's matter, taken when he answered: by its send, a read may have dropped its card.
    @ObservationIgnored private var heldMatters: [String: String?] = [:]

    func undo(_ ref: String) {
        heldMatters[ref] = nil
        holds.undo(ref)
    }

    /// Every held answer, at once: the screen is going, or the app.
    func sendHeld() async { await holds.sendAll() }

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

    /// His icon pick on `id` under way, from his tap until Life's reads say it: the key, or nil (Life picks again);
    /// none (the outer nil) when no pick is under way.
    func iconPicking(_ id: String) -> String?? { iconing[id] }

    /// His pick on `row` before the next one, which that one's Undo puts back: the pick last written until a read
    /// shows it, so a read that failed after the write never hands Undo the row from before it.
    func earlierIconPick(of row: MatterRow) -> String? {
        writtenIcons.earlierPick(of: row, loadedAt: matter[row.id]?.loadedAt)
    }

    /// His icon for a matter (a key of `MatterIcons`, or nil: Life picks again), said back with Undo, which puts back
    /// his pick it replaced (`was`, nil when the icon was Life's or none). One pick per matter at a time, through its
    /// reads: a second one before them would take its `was` from the read before the first.
    func setMatterIcon(of id: String, _ icon: String?, was: String?, saysBack: Bool = true) async {
        if await refusedOutOfReach(.edit(matter: id, .icon), saysBack: true) { return }
        let api = api
        _ = await iconing.run(id, showing: icon) {
            await edit(
                id, .icon,
                then: {
                    if case .succeeded = state(of: .edit(matter: id, .icon)) {
                        writtenIcons.wrote(icon, on: id, at: now())
                    }
                    // Said as soon as Life took it; the reads that show it come after.
                    say(
                        .edit(matter: id, .icon), saysBack ? "Icon changed" : nil,
                        undo: .icon(matter: id, was, was: icon))
                }
            ) { try await api.setMatterIcon(matter: id, icon: icon, onProgress: $0) }
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
        if await refusedOutOfReach(key, saysBack: true) { return }
        _ = await marking.run(id, showing: isOn) {
            await perform(key) { [runner] in
                await runner.record(emit: $0) { try await api.setImportant(matter: id, isOn, onProgress: $0) }
            }
            // Said as soon as Life took it; the reads that show it come after, his tap holding the mark meanwhile.
            say(
                key, saysBack ? (isOn ? "Marked important: it comes first" : "Not important") : nil,
                undo: .important(matter: id, !isOn))
            async let a: Void = refreshMatter(id)
            async let b: Void = refreshListsOf(id)
            async let c: Void = refreshInbox()
            _ = await (a, b, c)
        }
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
        if await refusedOutOfReach(.project(id), saysBack: true) { return }
        _ = await statusing.run(id, showing: status) {
            await perform(.project(id)) { [runner] in
                await runner.record(emit: $0) { try await api.setProjectStatus(id, status, said: said, onProgress: $0) }
            }
            // Said as soon as Life took it; the reads that show it come after.
            say(.project(id), words, undo: .status(project: id, name: name, was, was: status))
            async let a: Void = refreshProjects()
            async let b: Void = refreshProjectHead(id)
            async let c: Void = refreshScopedMatters(.project, id)
            async let d: Void = refreshMatters()
            _ = await (a, b, c, d)
        }
    }

    /// Its Undo as a tap, none when it was not done.
    func undoing(_ said: SaidBack) -> (() -> Void)? {
        said.undo == nil ? nil : { Task { await self.undo(said) } }
    }

    func undo(_ said: SaidBack) async {
        saidBack = nil
        switch said.undo {
        case .important(let id, let isOn)?:
            // Said back before its reads land (`setImportant`): Undo waits for them, else the tap would be refused.
            // ponytail: a 100 ms poll; a continuation on `PendingTaps` if another tap needs it.
            while marking[id] != nil {
                do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
            }
            await setImportant(id, isOn, saysBack: false)
        case .icon(let id, let icon, let was)?: await setMatterIcon(of: id, icon, was: was, saysBack: false)
        case .status(let id, let name, let status, let was)?:
            await setStatus(of: id, named: name, to: status, was: was, words: nil)
        case nil: break
        }
    }

    /// Says back how `key` ended: `words` with Undo when done, its reason when not (always), then nothing after 4 s.
    private func say(_ key: ActionKey, _ words: String?, undo: SaidBack.Undo) {
        let said: SaidBack? =
            switch state(of: key) {
            case .succeeded: words.map { SaidBack(words: $0, undo: undo, isDone: true) }
            case .failed(let failure, _): SaidBack(words: failure.reason, undo: nil, isDone: false)
            default: nil
            }
        guard let said else { return }
        show(said)
    }

    /// Leaves the app for `url` (a chat, a calendar): when the system takes none, `what` could not be opened is said back (the notification extension has no LifeStore: its chat head says so itself).
    func open(_ url: URL, _ what: String, with openURL: OpenURLAction) {
        openURL(url) { accepted in
            if !accepted {
                Task { @MainActor in self.show(SaidBack(words: "Couldn't open \(what).", undo: nil, isDone: false)) }
            }
        }
    }

    /// Shows `said` for 4 s, flagged when not done.
    func show(_ said: SaidBack) {
        saidBack = said
        Task {
            try? await Task.sleep(for: .seconds(4))
            if saidBack?.id == said.id { saidBack = nil }
        }
    }

    private func edit(
        _ id: String, _ what: ActionKey.Edit, then said: () -> Void = {},
        _ change: @escaping @Sendable (@escaping @Sendable (Data) -> Void) async throws -> String
    ) async {
        if await refusedOutOfReach(.edit(matter: id, what)) { return }
        await perform(.edit(matter: id, what)) { [runner] in await runner.record(emit: $0, change) }
        said()
        async let a: Void = refreshMatter(id)
        async let b: Void = refreshListsOf(id)
        _ = await (a, b)
    }

    /// Every list a change to matter `id` can move, read again: All, the chips and their counts, and each chip's list
    /// and project header read with it on show (its rank, flag, agent, or its leaving once done).
    func refreshListsOf(_ id: String) async {
        let held = (projects.value?.chips ?? []).filter {
            scopedMatters[$0.identity]?.value?.matters.contains { $0.id == id } == true
        }
        // Its project's header, if on show, read with or without its rows.
        let project = (matter[id]?.value?.row ?? listedRow(of: id))?.project?.id
        let head = project.flatMap { projectHead[$0] == nil ? nil : $0 }
        async let all: Void = refreshMatters()
        async let chips: Void = refreshProjects()
        for chip in held { await refreshScopedMatters(chip.kind, chip.id) }
        if let head { await refreshProjectHead(head) }
        _ = await (all, chips)
    }

    /// Matter `id`'s row as a list on hand has it (every running matter's, or a chip's): its page draws from it until
    /// the matter's own read lands.
    func listedRow(of id: String) -> MatterRow? {
        let lists = [matters] + Array(scopedMatters.values)
        return lists.lazy.compactMap { $0.value?.matters.first { $0.id == id } }.first
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
    /// How many asks wait, as the inbox read on screen said, less his answers: none from a pushed card alone or once
    /// the pairing is lost (`ReadState.waiting`). The Inbox's title.
    var waiting: Int? { inbox.waiting(less: answersNewer(than: inbox.loadedAt)) }
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
        (inbox, matters, matter, agents) = (ReadState(), ReadState(), [:], ReadState())
        (projects, projectHead, scopedMatters) = (ReadState(), [:], [:])
        spending = ReadState()
        (people, person, peopleFound, latest, prose, reach, openWith) = (ReadState(), [:], nil, [:], [:], [:], [:])
        (answered, pushed, moveReceipts, connection, lost) = (AnsweredCards(), nil, [:], LifeConnection(), nil)
        parties.startOver()
        holds.clear()
        // His actions and their keys were the last Life's: none goes on to this one.
        actions.startOver(pairing: parties.generation.current)
        taps = AnswerTaps()
        onStep(.reading)
        await refresh()
    }

    /// The card with that ref, as a tapped push opens it (`-fixtureCard`; Tell Life's "Open in Inbox").
    func open(ref: String) async {
        guard let pushId = inbox.value?.checks.first(where: { $0.ref == ref })?.pushId else { return }
        await open(pushId: pushId)
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

extension LifeStore {
    /// The program of the agent that asks a check (`Check.askingRuntime`).
    func runtimeName(of check: Check) -> RuntimeName? { agents.value.flatMap { check.askingRuntime(among: $0.agents) } }
}
