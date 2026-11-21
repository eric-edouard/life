import LifeConnector
import SwiftUI

/// What he typed on each ask and the answer he gave: kept by the screen that hosts the asks, above the size-class
/// branch, so folding or unfolding the phone keeps both.
struct CardNotes: Equatable {
    var inputs: [String: CardInput] = [:]
    var taken: Taken?
    /// The create sheet open over an ask: kept by the host, above its list of asks, so a read that takes the ask away
    /// (his answer) never closes it before it closes itself.
    var creating: Creating?
    /// The card his "Wrong…" sheet is open on, kept by the host the same way; his draft is the store's.
    var wrong: Check?
    /// On a bulk card: the rows he unticked, the answers he chose on a row's own card (sent with the others), the rows
    /// its "Answer N" sent, and the kinds he goes through one by one (`InboxOrder.folded`).
    var unticked: Set<String> = []
    var chosen: [String: Taken] = [:]
    var sentInBulk: Set<String> = []
    var unfolded: Set<CheckGroup> = []
    /// On the guesses' card: each row's answer in its own words ("Yes", "No"), kept for the row after its ask leaves.
    var guessed: [String: String] = [:]
    /// The rows it has shown, kept so an answered one stays (dimmed) after its ask left the inbox; and that it is
    /// being answered row by row (`InboxOrder.folded`'s `working`).
    var guesses: [Check] = []
    var working: Set<CheckGroup> = []

    /// The ask the host keeps on show whatever the read says: his result's, else the one the create sheet answers.
    var shownCheck: Check? { taken?.check ?? creating?.check }
}

/// The create sheet's ask and name, with where the asks go once it is created: the ask after it as he opened it (the
/// ask leaves the list while its answer runs).
struct Creating: Identifiable, Equatable {
    let check: Check
    let name: String
    /// Opened set to an organization ("Organization" on the card), else to a person.
    let isOrganization: Bool
    let nextRef: String?
    /// The pager's asks as the sheet opened, kept under it until it closes.
    let asks: [Check]
    /// The answer it zooms out of: "Create <name>" or "Organization" on the card, or the answer that opened the people
    /// sheet it was asked from.
    let source: AskSheet

    var id: String { "create " + check.ref + " " + name }
}

extension View {
    /// The asks' sheets of `notes`, presented by the host of the asks (the Inbox, a matter's page), above its reads: the
    /// create sheet, whose `leave` goes on from the ask once it is created, and his "Wrong…" sheet. The asks' sheets zoom
    /// out of the answer that opened them (`AskSheet`).
    func askSheets(_ notes: Binding<CardNotes>, leave: @escaping (Taken) -> Void) -> some View {
        modifier(AskSheetsHost(notes: notes, leave: leave))
    }
}

/// Which sheet an answer opens, the id its zoom comes out of: the people sheet, or the create sheet as a person or an
/// organization.
enum AskSheet: Hashable {
    case people(ref: String)
    case create(ref: String, asOrganization: Bool)
}

extension EnvironmentValues {
    /// The namespace the asks' sheets zoom in, set by their host (`askSheets`); nil where no host presents them.
    @Entry var askSheetZoom: Namespace.ID?
}

private struct AskSheetsHost: ViewModifier {
    @Binding var notes: CardNotes
    let leave: (Taken) -> Void
    @Namespace private var zoom

    func body(content: Content) -> some View {
        content
            .environment(\.askSheetZoom, zoom)
            .sheet(item: $notes.wrong) { check in WrongSheet(ref: check.ref).sheetStack() }
            .sheet(item: $notes.creating) { creating in
                CreateSheet(check: creating.check, name: creating.name, isOrganization: creating.isOrganization) {
                    request in
                    notes.creating = nil
                    leave(Taken(check: creating.check, request: request, nextRef: creating.nextRef, runtimeName: nil))
                }
                .sheetStack()
                .zooms(from: creating.source, in: zoom)
            }
    }
}

/// One ask on show, whoever hosts it (the Inbox, a matter's stack): the ask with its answers, then its result in its
/// place. `checks` are the asks around it, paged by swipe when there are several. A send or a start runs through the
/// store's action and the ask stays, as its own result: it moves on by itself once it worked, and waits for him when it
/// did not. With `holdsAnswers` every other answer is held four seconds for Undo and the next ask is on show at once.
struct CardView: View {
    let check: Check
    let checks: [Check]
    /// The kinds answered in bulk, by the ask that stands for each (`InboxOrder.bulk`): the Inbox's only.
    var bulk: [String: [Check]] = [:]
    /// The ask under the pager's leading edge: swiping only moves it, never answers.
    @Binding var current: String?
    @Binding var notes: CardNotes
    var notice: String?
    /// The ask's context region beside or below it: a matter's stack gives one, the Inbox none.
    var context: ContextRegion?
    /// Answers that are not a send or a start are held for Undo (the Inbox draws the toast), not shown as a result.
    /// Without it, only his word that a step is done is held (`Taken.isEnding`); the host draws its toast.
    var holdsAnswers = false
    /// A bulk card's row: an answer held for Undo is handed back to the row, nothing sent (`isHeld`).
    var takes: ((Taken) -> Void)?
    /// Back to what hosts the asks, with the ask he passed (and whether he kept it for later).
    let leave: (Taken, _ keep: Bool) -> Void

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @Environment(\.askSheetZoom) private var sheetZoom
    /// The people sheet open over an ask.
    @State private var peopleRef: String?
    /// The create sheet asked from the people sheet: the host opens it once the people sheet is gone.
    @State private var createsNext: Creating?

    var body: some View {
        CardArrangement(
            context: context,
            bar: result.map { taken in
                ResultButtons(
                    taken: taken, state: life.state(of: taken.key),
                    retry: { Task { await life.answer(taken.request, keepsCardOpen: taken.staysOpen) } },
                    keepForLater: { leave(taken, true) })
            }
        ) {
            // His tap's result takes the ask's place and rises in; once he moves on it goes the way an answered ask goes.
            ZStack {
                if let taken = result {
                    // A step ticking changes in place.
                    AnswerResultView(taken: taken, state: life.state(of: taken.key))
                        .motion(Motion.standard, value: life.state(of: taken.key))
                        .appears(Motion.result)
                } else {
                    VStack(spacing: 0) {
                        pager
                        if let notice {
                            Text(notice).font(.small).foregroundStyle(Palette.muted).padding(
                                .horizontal, Metrics.gutter
                            )
                            .padding(.vertical, Metrics.Spacing.xs * 2.5)
                            .frame(maxWidth: .infinity, alignment: .leading).background(Color.fillTint)
                        }
                    }
                    .appears(Motion.ask)
                }
            }
            .clipped()
        }
        .motion(Motion.rise, value: result != nil)
        // A send Life refused because someone wrote since: the ask is open again, with her message by its answers.
        .onChange(of: notes.taken != nil && result == nil) { _, isRefused in if isRefused { notes.taken = nil } }
        // A result that worked has said so: the next ask comes by itself.
        .task(id: isDone) {
            guard isDone, let taken = notes.taken else { return }
            try? await Task.sleep(for: .seconds(1.5))
            if !Task.isCancelled { leave(taken, false) }
        }
        .task(id: check.ref) { openFixtureSheet() }
        .sheet(isPresented: isShowingPeople, onDismiss: { (notes.creating, createsNext) = (createsNext, nil) }) {
            if let check = checks.first(where: { $0.ref == peopleRef }) {
                SameAsSheet(
                    people: check.likelyPeople, takesNewName: check.namingOption?.takes == .personOrName,
                    createsBySheet: check.createsBySheet, cardName: check.askedName
                ) { choice in
                    if let request = check.answer(naming: choice) { submit(check, request) }
                } create: {
                    (createsNext, peopleRef) = (creating(check, $0, from: .people(ref: check.ref)), nil)
                }
                .sheetStack()
                .zooms(from: AskSheet.people(ref: check.ref), in: sheetZoom)
            }
        }
    }

    /// The asks side by side, one page each, straight on the page: he swipes left for the next, right to come back, and the
    /// dots under the ask say where he is. The scroll view is one page wide, so a page's width is the paging step; with
    /// several asks it stops `Pager.edge` short of its box (as wide as its box, it never paged to the ask a push opens) and
    /// clips there, so nothing of the next ask shows. An ask he passes stays where it was.
    private var pager: some View {
        let checks = paged
        let edge = checks.count > 1 ? Pager.edge : 0
        return GeometryReader { box in
            ScrollViewReader { proxy in
                ScrollView(.horizontal) {
                    LazyHStack(spacing: 0) {
                        ForEach(Array(checks.enumerated()), id: \.element.ref) { index, check in
                            let page: (current: Int, total: Int)? = checks.count > 1 ? (index, checks.count) : nil
                            Group {
                                if let rows = bulk[check.ref] {
                                    BulkCard(
                                        kind: check.bulkKind, rows: rows, notes: $notes, page: page,
                                        finish: { current = checks.ref(after: check.ref) }
                                    ) {
                                        submit(all: $0, from: check)
                                    }
                                } else {
                                    CheckCard(
                                        check: check, runtimeName: life.runtimeName(of: check),
                                        openMatter: { router.open(matter: $0) },
                                        input: input(check.ref),
                                        isBusy: life.state(of: .answer(ref: check.ref)).isRunning,
                                        answer: { submit(check, $0) }, sameAs: { peopleRef = check.ref },
                                        create: { notes.creating = creating(check, $0, asOrganization: $1) },
                                        wrong: {
                                            life.openComplaint(on: check)
                                            notes.wrong = check
                                        },
                                        dropProject: dropProject(of: check),
                                        page: page
                                    )
                                }
                            }
                            .padding(.leading, Pager.gap)
                            .containerRelativeFrame(.horizontal)
                            .appears(Motion.passes)
                            .id(check.ref)
                        }
                    }
                    .scrollTargetLayout()
                }
                .frame(width: box.size.width - edge - Pager.gap)
                .scrollPosition(id: $current, anchor: .leading)
                .scrollTargetBehavior(.paging)
                .scrollIndicators(.hidden)
            }
        }
        .clipped()
        // An answered ask leaves and the next enters together (`Motion.passes`).
        .motion(Motion.rise, value: checks.map(\.ref))
    }

    /// His tap's result, unless it reopened the ask (a send refused because someone wrote since).
    private var result: Taken? {
        guard let taken = notes.taken else { return nil }
        if case .failed(let failure, _) = life.state(of: taken.key), failure.wrote != nil { return nil }
        return taken
    }

    /// His tap is over (`isDone`): Life answered, or his send was seen in its chat and only the answer was lost.
    private var isDone: Bool {
        notes.taken.map { life.state(of: $0.key).isDone(isSend: $0.isSend) } ?? false
    }

    private func input(_ ref: String) -> Binding<CardInput> {
        Binding(get: { notes.inputs[ref] ?? CardInput() }, set: { notes.inputs[ref] = $0 })
    }

    /// The asks the pager shows: while the create sheet is up, those it opened over, so the next ask never comes in
    /// behind it before it closes.
    private var paged: [Check] { notes.creating?.asks ?? checks }

    /// The people sheet goes with its ask.
    private var isShowingPeople: Binding<Bool> {
        Binding(get: { checks.contains { $0.ref == peopleRef } }, set: { if !$0 { peopleRef = nil } })
    }

    /// `-fixtureSheet create`: the create sheet over the ask on show, to be photographed.
    private func openFixtureSheet() {
        #if DEBUG
            if LifeFixture.sheet == "create", check.createsByName, let name = check.askedName {
                notes.creating = creating(check, name)
            }
        #endif
    }

    /// "I dropped this whole project": the card's matter's project parked, when it is underway (from the matters read:
    /// a card names its matter, not its project).
    private func dropProject(of check: Check) -> (() -> Void)? {
        guard let id = check.matter?.id,
            let project = life.matters.value?.matters.first(where: { $0.id == id })?.project,
            project.status.isUnderway
        else { return nil }
        return {
            Task {
                await life.setStatus(
                    of: project.id, named: project.name, to: .parked, was: project.status,
                    words: "\(project.name) parked")
            }
        }
    }

    /// The create sheet for `check`, with the ask after it as he opened it, zooming out of the answer that opened it
    /// (by default the card's own create answer).
    private func creating(_ check: Check, _ name: String, asOrganization: Bool = false, from source: AskSheet? = nil)
        -> Creating
    {
        Creating(
            check: check, name: name, isOrganization: asOrganization, nextRef: checks.ref(after: check.ref),
            asks: checks, source: source ?? .create(ref: check.ref, asOrganization: asOrganization))
    }

    /// A bulk card's answers, held as one for one Undo; the next ask is on show at once.
    private func submit(all requests: [AnswerRequest], from head: Check) {
        guard !requests.isEmpty else { return }
        // A new attempt: an earlier answer's failure on these rows is no longer theirs.
        requests.forEach { life.forget(.answer(ref: $0.ref)) }
        notes.sentInBulk.formUnion(requests.map(\.ref))
        life.hold(requests, as: "\(requests.count) answered")
        current = checks.ref(after: head.ref)
    }

    private func submit(_ check: Check, _ request: AnswerRequest) {
        let taken = Taken(
            check: check, request: request, nextRef: checks.ref(after: check.ref),
            runtimeName: life.runtimeName(of: check))
        if let takes, taken.isHeld {
            takes(taken)
        } else if holdsAnswers && taken.isHeld {
            life.hold(request, as: taken.heldWords)
            current = taken.nextRef
        } else if taken.isEnding {
            // Off the Inbox too (a matter's stack): held for Undo, which the host's toast offers, then sent.
            life.hold(request, as: taken.heldWords)
            leave(taken, false)
        } else {
            notes.taken = taken
            Task { await life.answer(request, keepsCardOpen: taken.staysOpen) }
        }
    }
}

/// The pager's measures: 12 from the sides and between asks, and the edge it stops short of its box.
private enum Pager {
    static let gap = Metrics.Spacing.xs * 3
    static let edge = Metrics.Spacing.xs * 2.5
}

/// An ask pushed on a matter's stack, or in a project's sheet: found by its ref among the checks the matter lists, or,
/// once answered, the result he is still reading. Gone from both: said so.
struct CardPage: View {
    let ref: String
    let source: [Check]
    @Binding var notes: CardNotes
    /// Back to the stack's root: after his answer's result, or when the ask is gone.
    let leave: () -> Void

    @Environment(LifeStore.self) private var life
    @State private var current: String?

    var body: some View {
        // Its bar is its host's: Back and the Pendant on a matter's stack, Close in a sheet.
        page
            // Above the ask, so the matter's read that takes it away (his answer) never closes it before it does.
            .askSheets($notes) { _ in leave() }
    }

    @ViewBuilder private var page: some View {
        if let check = notes.shownCheck.flatMap({ $0.ref == ref ? $0 : nil }) ?? source.first(where: { $0.ref == ref })
        {
            CardView(
                check: check, checks: [check], current: $current, notes: $notes,
                context: ContextRegion(check: check, runtimeName: life.runtimeName(of: check))
            ) { taken, _ in
                // A new matter whose goal he edited still waits for Start or Dismiss: back to the ask, not the matter.
                if taken.staysOpen {
                    life.forget(taken.key)
                    (notes.taken, current) = (nil, nil)
                } else {
                    leave()
                }
            }
            .background(Palette.bg)
        } else {
            Notice(
                title: "Already answered.", detail: "It was answered, here or elsewhere.",
                action: ("Back", leave)
            )
            .background(Palette.bg)
        }
    }
}
