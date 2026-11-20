import LifeConnector
import SwiftUI

/// What he typed on each ask and the answer he gave: kept by the screen that hosts the asks, above the size-class
/// branch, so folding or unfolding the phone keeps both.
struct CardNotes: Equatable {
    var inputs: [String: CardInput] = [:]
    var taken: Taken?
}

/// One ask on show, whoever hosts it (the Inbox, a matter's stack): the ask with its answers, then its result in its
/// place. `checks` are the asks around it, paged by swipe when there are several. A send or a start runs through the
/// store's action and the ask stays, as its own result: it moves on by itself once it worked, and waits for him when it
/// did not. With `holdsAnswers` every other answer is held four seconds for Undo and the next ask is on show at once.
struct CardView: View {
    let check: Check
    let checks: [Check]
    /// The ask under the pager's leading edge: swiping only moves it, never answers.
    @Binding var current: String?
    @Binding var notes: CardNotes
    var notice: String?
    /// The ask's context region beside or below it: a matter's stack gives one, the Inbox none.
    var context: ContextRegion?
    /// Answers that are not a send or a start are held for Undo (the Inbox draws the toast), not shown as a result.
    /// Without it, only his word that a step is done is held (`Taken.isEnding`); the host draws its toast.
    var holdsAnswers = false
    /// Back to what hosts the asks, with the ask he passed (and whether he kept it for later).
    let leave: (Taken, _ keep: Bool) -> Void

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    /// The sheet open over an ask.
    @State private var sheet: CardSheet?

    var body: some View {
        CardArrangement(
            context: context,
            bar: result.map { taken in
                ResultButtons(
                    taken: taken, state: life.state(of: taken.key),
                    retry: { Task { await life.answer(taken.request) } }, keepForLater: { leave(taken, true) })
            }
        ) {
            if let taken = result {
                AnswerResultView(taken: taken, state: life.state(of: taken.key))
            } else {
                VStack(spacing: 0) {
                    pager
                    if let notice {
                        Text(notice).font(.small).foregroundStyle(Palette.muted).padding(.horizontal, Metrics.gutter)
                            .padding(
                                .vertical, Metrics.Spacing.xs * 2.5
                            )
                            .frame(maxWidth: .infinity, alignment: .leading).background(Color.fillTint)
                    }
                }
            }
        }
        // A send Life refused because someone wrote since: the ask is open again, with her message by its answers.
        .onChange(of: notes.taken != nil && result == nil) { _, isRefused in if isRefused { notes.taken = nil } }
        // A result that worked has said so: the next ask comes by itself.
        .task(id: isDone) {
            guard isDone, let taken = notes.taken else { return }
            try? await Task.sleep(for: .seconds(1.5))
            if !Task.isCancelled { leave(taken, false) }
        }
        .task(id: check.ref) { openFixtureSheet() }
        .sheet(item: shownSheet) { route in
            switch route {
            case .people(let ref):
                if let check = checks.first(where: { $0.ref == ref }) {
                    SameAsSheet(
                        people: check.likelyPeople, takesNewName: check.namingOption?.takes == .personOrName,
                        cardName: check.askedName
                    ) { choice in
                        if let request = check.answer(naming: choice) { submit(check, request) }
                    } create: {
                        sheet = creating(check, $0)
                    }
                    .sheetStack()
                }
            case .create(let check, let name, let nextRef, _):
                CreateSheet(check: check, name: name) { request in
                    sheet = nil
                    leave(Taken(check: check, request: request, nextRef: nextRef, runtimeName: nil), false)
                }
                .sheetStack()
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
                            CheckCard(
                                check: check, runtimeName: life.runtimeName(of: check),
                                openMatter: { router.open(matter: $0) },
                                input: input(check.ref),
                                isBusy: life.state(of: .answer(ref: check.ref)).isRunning,
                                answer: { submit(check, $0) }, sameAs: { sheet = .people(ref: check.ref) },
                                create: { sheet = creating(check, $0) },
                                page: checks.count > 1 ? (index, checks.count) : nil
                            )
                            .padding(.leading, Pager.gap)
                            .containerRelativeFrame(.horizontal)
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
        .motion(Motion.standard, value: checks.map(\.ref))
    }

    /// His tap's result, unless it reopened the ask (a send refused because someone wrote since).
    private var result: Taken? {
        guard let taken = notes.taken else { return nil }
        if case .failed(let failure, _) = life.state(of: taken.key), failure.wrote != nil { return nil }
        return taken
    }

    private var isDone: Bool {
        guard let taken = notes.taken, case .succeeded = life.state(of: taken.key) else { return false }
        return true
    }

    private func input(_ ref: String) -> Binding<CardInput> {
        Binding(get: { notes.inputs[ref] ?? CardInput() }, set: { notes.inputs[ref] = $0 })
    }

    /// The asks the pager shows: while the create sheet is up, those it opened over, so the next ask never comes in
    /// behind it before it closes.
    private var paged: [Check] {
        if case .create(_, _, _, let asks) = sheet { asks } else { checks }
    }

    /// The sheet over an ask: its people sheet goes with the ask; the create sheet stays while its answer runs (the ask
    /// leaves the list then) until it closes itself.
    private var shownSheet: Binding<CardSheet?> {
        Binding(
            get: {
                if case .people(let ref) = sheet, !checks.contains(where: { $0.ref == ref }) { return nil }
                return sheet
            },
            set: { sheet = $0 })
    }

    /// `-fixtureSheet create`: the create sheet over the ask on show, to be photographed.
    private func openFixtureSheet() {
        #if DEBUG
            if LifeFixture.sheet == "create", check.createsByName, let name = check.askedName {
                sheet = creating(check, name)
            }
        #endif
    }

    /// The create sheet for `check`, with where the asks go once it is created: the ask after it as he opened it (the
    /// ask leaves the list while its answer runs).
    private func creating(_ check: Check, _ name: String) -> CardSheet {
        .create(check, name: name, nextRef: checks.ref(after: check.ref), asks: checks)
    }

    private func submit(_ check: Check, _ request: AnswerRequest) {
        let taken = Taken(
            check: check, request: request, nextRef: checks.ref(after: check.ref),
            runtimeName: life.runtimeName(of: check))
        if holdsAnswers && taken.isHeld {
            life.hold(request, as: taken.heldWords)
            current = taken.nextRef
        } else if taken.isEnding {
            // Off the Inbox too (a matter's stack): held for Undo, which the host's toast offers, then sent.
            life.hold(request, as: taken.heldWords)
            leave(taken, false)
        } else {
            notes.taken = taken
            Task { await life.answer(request) }
        }
    }
}

/// A sheet over an ask: its people ("Someone I know…"), or the create sheet with a name.
private enum CardSheet: Identifiable {
    case people(ref: String)
    /// `asks`: the pager's asks as the sheet opened, kept under it until it closes (its own ask leaves the list while
    /// its answer runs).
    case create(Check, name: String, nextRef: String?, asks: [Check])

    var id: String {
        switch self {
        case .people(let ref): "people " + ref
        case .create(let check, let name, _, _): "create " + check.ref + " " + name
        }
    }
}

/// The pager's measures: 12 from the sides and between asks, and the edge it stops short of its box.
private enum Pager {
    static let gap = Metrics.Spacing.xs * 3
    static let edge = Metrics.Spacing.xs * 2.5
}

/// An ask pushed on a matter's stack: found by its ref among the checks the matter lists, or, once answered, the
/// result he is still reading. Gone from both: said so.
struct CardPage: View {
    let ref: String
    let source: [Check]
    @Binding var notes: CardNotes
    /// Back to the stack's root: after his answer's result, or when the ask is gone.
    let leave: () -> Void

    @Environment(LifeStore.self) private var life
    @State private var current: String?

    var body: some View {
        page
            // A pushed screen: Back, then the Pendant.
            .shellBar("", hasSettings: false)
    }

    @ViewBuilder private var page: some View {
        if let check = notes.taken?.check.ref == ref ? notes.taken?.check : source.first(where: { $0.ref == ref }) {
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
