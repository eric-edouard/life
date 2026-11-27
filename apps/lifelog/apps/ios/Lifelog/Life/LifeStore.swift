import Foundation
import Incidents
import Library
import LifeConnector
import Observation
import SwiftUI
import UserNotifications

/// The phone's side of Life: the thread's asks as Life reads them (`items`, one read), his answers, each an
/// `ActionState`, the ones taken while Life was out of reach (`queued`), the count on the round button, and the pairing
/// that makes them possible. The app holds no second API: everything goes through Life's connector (`LifeConnector`,
/// in Kit). A cold start fills the read from the last good answer, so with no Mac in reach a screen shows it, never blank.
@MainActor @Observable
final class LifeStore {
    /// The newest page of his thread, of which only the asks are read here (the entries are `thread`'s).
    private(set) var items = ReadState<ThreadRead>()
    /// A person's or organization's page, by ref: what their profile shows.
    private(set) var person: [String: ReadState<PersonNow>] = [:]
    /// His directory (`PeopleList`), for the person picker.
    private(set) var people = ReadState<PeopleList>()
    /// Everyone the reads name, and their pictures.
    let parties: PartyBook

    /// What an action acts on: the store makes every key itself, so a screen asks for the state of what it shows.
    nonisolated enum ActionKey: Hashable, Sendable {
        /// His answer to an ask, his Later or his Undo of it, by its ref.
        case answer(ref: String)
        /// His Remove or Undo of an appointment Life added to his calendar, by its id.
        case appointment(String)
    }

    /// Every action by what it acts on: its steps as they stream, then its proof or why not.
    private(set) var actions = ActionBook<ActionKey>()
    /// His answers taken while Life was out of reach, in order, each sent once with its own tap's key when it is back.
    private(set) var queued = QueuedAnswers()
    /// What the last flush of `queued` did, said once in the notice that settles: how many went, how many were dropped.
    private(set) var caughtUp: Catchup?
    /// The ask a tapped notification names: the thread unfolds it (`focused`), then lets it go (`clearFocus`).
    private(set) var focused: String?
    /// The ask unfolded in the thread now: what the field's words are about (`MainSessionScreen.open`).
    var opened: String?
    /// The voice ask being named (the Ask Life field is where he types or says the name), and the words typed so far.
    var naming: String?
    var namingWords = ""
    /// The voice he named last: the line above the next one ("Clara Hart: named · Undo").
    private(set) var namedVoice: NamedVoice?

    struct NamedVoice: Equatable {
        let ref: String
        let who: String
    }

    /// The sign-in a fix card's tap asked for (`Check.Option.signsIn`): `RootView` opens its sheet and clears it.
    var signingIn: SignInAsk?

    struct Catchup: Equatable {
        let sent: Int
        let dropped: Int
    }

    /// The Life this phone is paired with: set by a pairing, gone once Life no longer knows it (a read says so).
    private(set) var pairedOrigin: URL?
    /// Since when Life cannot be reached, for the notice that says so.
    private(set) var lostSince: Date?

    /// Registers with Life and has the pairing code approve it (`LifeOAuth`); a test or a fixture gives its own.
    typealias Approve = @Sendable (LifePairing) async throws -> LifeCredentials

    private let tokens: any TokenStore
    private let approve: Approve
    private let api: any LifeAPI
    private let cache: ReadCache
    let runner: LifeActions
    /// His one conversation with Life's main session.
    let thread: LifeThread
    let now: @Sendable () -> Date
    private let setBadge: @MainActor (Int) -> Void
    /// The phone's network path, which the pendant's sync follows too.
    private let path: NetworkPath
    /// How the newest settled read ended: with the path, whether Life can be reached (`whyOutOfReach`).
    /// Kept out of observation (its `asked` moves on every read); `lost` is the part a screen watches, set only when it changes.
    @ObservationIgnored private var connection = LifeConnection()
    private var lost: MCPError?
    /// One read of each kind at a time, plus one more pass.
    @ObservationIgnored private let flights: ReadFlights
    /// The key of a tap whose call may have run (its connection failed): the same tap repeats with it, so Life sends nothing twice.
    private var taps = AnswerTaps()
    private var isFlushing = false
    @ObservationIgnored private var hasReadSinceLaunch = false

    private static let itemsKey = "read_thread"
    private static let queuedKey = "queued_answers"

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
        thread = LifeThread(
            api: api,
            cache: ReadCache(directory: URL.applicationSupportDirectory.appending(path: "lifelog/life-thread")),
            now: now)
        self.cache = cache
        self.now = now
        self.setBadge = setBadge
        self.path = path
        pairedOrigin = tokens.load()?.endpoint.origin
        if let kept = cache.load(Self.itemsKey), let value = try? ThreadRead.parsed(kept.text) {
            parties.remember(value.parties, at: kept.at, pairing: parties.generation.current)
            items.apply(.succeeded(value, kept.at))
        }
        if let kept = cache.load(Self.queuedKey),
            let value = try? JSONDecoder().decode(QueuedAnswers.self, from: Data(kept.text.utf8))
        {
            queued = value
        }
    }

    var isPaired: Bool { pairedOrigin != nil }
    /// Whether the phone has a network path at all; back, the reads are made again.
    var hasPath: Bool { path.network != .none }
    /// Why Life cannot be reached now (no internet, or the newest read found the Mac out of reach), nil when it can.
    var whyOutOfReach: String? {
        _ = lost  // the observed part of `connection`
        return connection.whyNot(hasPath: hasPath)
    }
    var isOutOfReach: Bool { whyOutOfReach != nil }
    /// Out of reach because the phone has no way out (not because the Mac does not answer).
    var isOffline: Bool { !hasPath || lost == .offline }
    /// Whether Life answers: its thread read, the one every screen starts from.
    var link: LinkState { outcome.link(hasRead: items.value != nil) }

    func state(of key: ActionKey) -> ActionState<ActionProof> { actions[key] ?? .idle }

    /// Forgets an action's result once the screen has shown it.
    func forget(_ key: ActionKey) { actions.forget(key) }

    // MARK: Reads

    /// Coming forward: the thread's asks, unless read in the last 30 s (a card's push says what changed since).
    func refreshOnForeground() async {
        // A read kept from the last launch is not one of this launch: Life may be gone since, and only a read says so.
        if hasReadSinceLaunch, let read = items.loadedAt, now().timeIntervalSince(read) < Self.foregroundReadsAfter {
            return
        }
        await refresh()
    }

    private static let foregroundReadsAfter: TimeInterval = 30

    /// The asks read again, then the answers taken meanwhile sent.
    func refresh() async {
        await refreshItems()
        await flushQueued()
    }

    /// Whether the first read is still missing and worth trying again.
    var needsRetry: Bool { items.needsRetry }

    func retryFirstReads() async { if items.needsRetry { await refreshItems() } }

    func refreshItems() async {
        hasReadSinceLaunch = true
        let before = items.loadedAt
        await load({ self.items.apply($0) }, key: Self.itemsKey, held: { self.items.value }) {
            try await $0.readThread(before: nil, ifNot: $1)
        }
        if items.value != nil { setBadge(waitingCount ?? 0) }
        // Only a whole read says what is no longer open: a cached or failed one does not.
        if items.loadedAt != before, let asked = items.loadedAt, let read = items.value {
            thread.adopt(read.entries, asked: asked)
            let open = Set(read.asks.compactMap { $0.isAnswerable ? $0.check?.pushId : nil })
            await Self.removeNotifications(deliveredBefore: asked) { !open.contains($0) }
        }
    }

    /// A card answered anywhere (here, in another app, withdrawn) leaves his notifications too: on a read, only one
    /// delivered before the read was asked, or on Life's push naming the cards that left (`NotificationRoute.removed`),
    /// which spares the result of his answer from a notification (`sparingResults`).
    /// Off the main actor: the notification center's calls are synchronous IPC (`IncidentNotifier.remove`).
    @concurrent nonisolated static func removeNotifications(
        deliveredBefore asked: Date = .distantFuture, sparingResults: Bool = false,
        where isGone: @Sendable (String) -> Bool
    ) async {
        #if DEBUG
            if E2E.isOn { return }  // the simulator's notification center may never answer
        #endif
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

    /// A person's or organization's page (`<ref>/now`), read when their profile opens.
    func refreshPerson(_ ref: String) async {
        await load({ self.person[ref, default: ReadState()].apply($0) }, key: "person-\(ref)", isKept: false) {
            try await $0.readPart("\(ref)/now")
        }
    }

    /// A matter's page (`read_matter`): read when its link opens, kept by the sheet.
    func readMatter(_ id: String, _ update: @escaping (ReadState<Matter>.Event) -> Void) async {
        await load(update, key: "read_matter-\(id)", isKept: false) { try await $0.readMatter(id) }
    }

    /// His directory, read when the person picker opens.
    func refreshPeople() async {
        await load({ self.people.apply($0) }, key: "people", isKept: false) { try await $0.readPeople() }
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

    /// His halo settings saved: the aura Life kept, as it answered.
    func saveAura(_ aura: AuraSetting) async throws -> AuraSetting {
        guard let kept = AuraSetting.saved(in: try await api.changeSetting(aura: aura)) else {
            throw MCPError.failed("Life did not keep it.")
        }
        return kept
    }

    /// The read `key`, one pass at a time (`ReadFlights`): its value applies as of when its pass began, and is kept for a
    /// cold start unless `isKept` is false. A read of the Life paired before this one applies nothing, not even its
    /// failure (`PairingGeneration`).
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
                if self.lost != self.connection.lost {
                    self.lost = self.connection.lost
                    self.lostSince = self.lost == nil ? nil : self.lostSince ?? asked
                }
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

    /// A read's text decoded, and kept for a cold start (`cache`), off the main actor.
    @concurrent private nonisolated static func parsed<V: ParsedRead>(
        _ text: String, as: V.Type, keptIn cache: ReadCache?, key: String, asked: Date
    ) async throws -> V {
        let value = try V.parsed(text)
        cache?.store(text, key: key, asked: asked)
        return value
    }

    // MARK: Asks

    /// The ask `ref`, as the newest read has it.
    func ask(_ ref: String) -> ThreadAsk? { items.value?.ask(ref) }

    /// Whether his answer to `ref` waits for Life to be back.
    func isQueued(_ ref: String) -> Bool { queued.holds(ref) }

    /// How many asks block him, less those he answered meanwhile: the round button's count and the app's badge.
    var waitingCount: Int? { waitingRefs.map(\.count) }

    /// The owner's temporary variant of 27 Nov 2026: every open ask waiting on him (the thread read's answerable asks), less those he answered meanwhile.
    var openCount: Int? { items.value.map { read in read.asks.filter { $0.isAnswerable && !queued.holds($0.ref) }.count } }

    /// Those asks' refs, in Life's order.
    var waitingRefs: [String]? {
        items.value.map { read in read.blocking.filter { !queued.holds($0.ref) }.map(\.ref) }
    }

    /// A tapped notification: its ask is unfolded in the thread, once the asks are read again.
    func focus(pushId: String) async {
        await refreshItems()
        focused = items.value?.asks.first { $0.check?.pushId == pushId }?.ref
    }

    /// Unfolds an ask he reached by a link in Life's words.
    func focus(ref: String) { focused = ref }

    func clearFocus() { focused = nil }

    // MARK: Actions

    /// Runs one action under `key`: its events are applied in the order they came, and a second tap while it runs is
    /// ignored. `succeeded` runs in the step that applies its success, so no frame shows it neither running nor done.
    /// An answer (`tap`) the Mac has said nothing about for `MacSilence.noAnswerAfter` ends not done, and its late events
    /// apply nothing (the same tap may run again meanwhile): true then.
    @discardableResult func perform(
        _ key: ActionKey, tap: String? = nil, succeeded: @escaping () -> Void = {},
        _ body: @escaping @Sendable (@escaping LifeActions.Emit) async -> Void
    ) async -> Bool {
        let (began, pairing) = (now(), actions.pairing)
        guard actions.begin(key, at: began) else { return false }
        let (events, emit) = AsyncStream.makeStream(of: ActionState<ActionProof>.Event.self)
        var (limit, isSilenced) = (Date?.none, false)
        let consumer = Task {
            // Applied only within its pairing: after another, its key may be a new tap's, on that Life's card.
            for await event in events {
                guard !isSilenced, actions.apply(event, to: key, begunIn: pairing, at: now()) else { continue }
                if case .succeeded = event { succeeded() }
                limit = actions[key]?.limit ?? limit
            }
        }
        // Only an answer has a tap's key that makes trying again safe: only it ends on the Mac's silence.
        let watch = Task {
            while tap != nil, (try? await Task.sleep(for: .seconds(1))) != nil, pairing == actions.pairing, !isSilenced
            {
                guard actions.endIfSilent(key, at: now()), let ended = actions[key] else { continue }
                isSilenced = true
                traceAction(key, tap: tap, ended, began: began, finished: now(), limit: limit)
            }
        }
        await body { emit.yield($0) }
        emit.finish()
        await consumer.value
        watch.cancel()
        guard pairing == actions.pairing else { return isSilenced }
        if !isSilenced, let ended = actions[key] {
            traceAction(key, tap: tap, ended, began: began, finished: now(), limit: limit)
        }
        return isSilenced
    }

    /// His answer to an ask: sent now, or kept for when Life is back while it is out of reach (a tap on a screen; an
    /// answer from a notification is tried at once). A call that failed on the connection is repeated as the same tap;
    /// a result Life gave (a send that was not sent included) makes the next tap a new one.
    /// `life`: the Life it was decided for, when his tap was not on the screen now (a notification's button); else the
    /// one paired at this tap.
    func answer(_ request: AnswerRequest, for life: PairedLife? = nil) async {
        // A sign-in option is never an answer (`answer_check` refuses it): it opens the network's sign-in sheet.
        if let check = ask(request.ref)?.check,
            let network = check.options.first(where: { request.options.contains($0.id) })?.signsIn
        {
            signingIn = SignInAsk(network: network, title: check.title)
            return
        }
        // A send in flight is never replaced or queued over: the old and the new would both go out.
        guard !state(of: .answer(ref: request.ref)).isRunning else { return }
        if life == nil, isOutOfReach, let origin = pairedOrigin, !request.isUndo {
            queued.add(request, key: taps.key(for: request), origin: origin, at: now())
            return saveQueued()
        }
        // Leaving the app mid-request does not stop the send.
        let awake = Awake()
        awake.id = UIApplication.shared.beginBackgroundTask(withName: "answer") { awake.end() }
        await send(request, for: life ?? pairedLife)
        awake.end()
        // The button shows its done for a moment, then the ask takes the state Life gives it.
        if life == nil, case .succeeded = state(of: .answer(ref: request.ref)) {
            try? await Task.sleep(for: .seconds(1))
        }
        await refreshItems()
    }

    /// One sign-in to `network`, step by step, on the Life paired now.
    func signIn(_ network: String) -> NetworkSignIn {
        NetworkSignIn(network: network) { [api] in try await api.signInToNetwork($0) }
    }

    /// His answer to a voice ask: who it is (`who`, for the line above the next one) or no one (`who` nil).
    func answerVoice(_ check: Check, _ request: AnswerRequest?, who: String?) async {
        guard let request else { return }
        naming = nil
        namingWords = ""
        if let who { namedVoice = NamedVoice(ref: check.ref, who: who) }
        await answer(request)
    }

    /// His people whose name holds the words typed in the field while a voice is named, at most three.
    var namingMatches: [Party] {
        guard !namingWords.trimmingCharacters(in: .whitespaces).isEmpty else { return [] }
        let rows = people.value?.sections(kind: .people, query: namingWords).flatMap(\.rows) ?? []
        return rows.prefix(3).map(\.party)
    }

    /// The field's Send while a voice is named: the one person who matches exactly, else a new person by that name.
    func nameTyped() async {
        let typed = namingWords.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let ref = naming, let check = ask(ref)?.check, !typed.isEmpty else { return }
        if let party = namingMatches.first(where: { $0.name.localizedCaseInsensitiveCompare(typed) == .orderedSame }) {
            await answerVoice(check, check.answer(naming: .person(party.ref)), who: party.name)
        } else {
            await answerVoice(check, check.answer(naming: .name(typed)), who: typed)
        }
    }

    /// His Later on an ask: Life picks until when.
    func later(_ ref: String) async { await answer(.later(ref)) }

    /// His Undo of an answer or a send (`answer_check`'s `undo`): an attempt; the ask says how it went.
    func undo(_ ref: String) async { await answer(.undoing(ref)) }

    /// The Life the phone is paired with now, as an answer decided now captures it (`PairedLife`).
    var pairedLife: PairedLife? {
        pairedOrigin.map { PairedLife(origin: $0, generation: parties.generation.current) }
    }

    /// The answer's call alone, until Life's answer to it, to the Life it was decided for (`life`) and no other: one
    /// decided under an earlier pairing, or none, is refused here and never sent.
    private func send(_ request: AnswerRequest, for life: PairedLife?) async {
        let key = ActionKey.answer(ref: request.ref)
        guard actions[key]?.isRunning != true else { return }
        guard let life, life.generation == parties.generation.current else { return await refuseUnpaired(key) }
        let (tap, generation) = (taps.key(for: request), parties.generation)
        let isSilenced = await perform(key, tap: tap) { [runner] in
            await runner.answer(
                request, key: tap, at: life.origin, whilePaired: { generation.current == life.generation }, emit: $0)
        }
        // Silenced, its tap's key stays: the same tap may already run again with it.
        if !isSilenced, life.generation == actions.pairing, let ended = actions[key] { taps.ended(request, as: ended) }
    }

    /// An action with no Life to go to: refused before anything leaves the phone, as not paired.
    private func refuseUnpaired(_ key: ActionKey) async {
        await perform(key) { emit in
            emit(.started)
            emit(.failed(ActionFailure(.notPaired)))
        }
    }

    // MARK: Offline

    /// Back in reach, each answer taken meanwhile goes in order with its own tap's key and to the Life it was decided
    /// for; Life itself drops one whose ask went out of date. What went and what was dropped is said once (`caughtUp`).
    func flushQueued() async {
        guard !isFlushing, !isOutOfReach, pairedOrigin != nil, !queued.entries.isEmpty else { return }
        isFlushing = true
        defer { isFlushing = false }
        var (sent, dropped) = (0, 0)
        for entry in queued.entries {
            guard entry.origin == pairedOrigin else { queued.remove(entry.request.ref); dropped += 1; continue }
            let key = ActionKey.answer(ref: entry.request.ref)
            let generation = parties.generation
            let life = PairedLife(origin: entry.origin, generation: generation.current)
            await perform(key, tap: entry.key) { [runner] in
                await runner.answer(
                    entry.request, key: entry.key, at: life.origin,
                    whilePaired: { generation.current == life.generation }, emit: $0)
            }
            switch state(of: key) {
            case .succeeded: sent += 1
            case .failed(let failure, _) where failure.retry == .allowed && failure.mayHaveHappened == false: continue
            default: dropped += 1
            }
            queued.remove(entry.request.ref)
        }
        saveQueued()
        if sent + dropped > 0 { caughtUp = Catchup(sent: sent, dropped: dropped) }
        await refreshItems()
    }

    func clearCaughtUp() { caughtUp = nil }

    private func saveQueued() {
        if let data = try? JSONEncoder().encode(queued) {
            cache.store(String(decoding: data, as: UTF8.self), key: Self.queuedKey)
        }
        if items.value != nil { setBadge(waitingCount ?? 0) }
    }

    // MARK: Notifications

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
        thread.startOver()
        (items, person, queued, caughtUp, focused) = (ReadState(), [:], QueuedAnswers(), nil, nil)
        (connection, lost, lostSince) = (LifeConnection(), nil, nil)
        parties.startOver()
        // His actions and their keys were the last Life's: none goes on to this one.
        actions.startOver(pairing: parties.generation.current)
        taps = AnswerTaps()
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
