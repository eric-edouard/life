import LifeConnector
import SwiftUI

/// The asks' place, kept by the router so the list (beside the page or its root) and the ask on show read one order.
struct AskPlace: Equatable {
    var notes = CardNotes()
    /// Asks he kept for later: shown after the others, until the app closes.
    var deferred: [String] = []
    var current: String?
    /// The kind of ask the list and the pager keep to; nil is everything. Not stored: it ends with the app.
    var kind: CheckGroup? = startKind
    var notice: String?
    /// Nothing is chosen at first; a fixture launch may open on the Filter's "Your moves" (`-fixtureFilter moves`).
    private static var startKind: CheckGroup? {
        #if DEBUG
            LifeFixture.filter == "moves" ? .yourMove : nil
        #else
            nil
        #endif
    }

    /// What blocks, then what can wait: `Inbox.ordered`, the one rule for the list, the pager, the ask on show and where
    /// an answer leads (`only` keeps the chosen kind of it). The store already left out his answers; the one shown as
    /// his result is no row either.
    func all(_ inbox: Inbox?) -> InboxOrder {
        inbox?.ordered(deferred: deferred, except: Set(notes.taken.map { [$0.check.ref] } ?? [])) ?? InboxOrder()
    }

    /// `all` as shown: of `kind`, cut by Ask Life, with each kind Life pre-ticks folded into one bulk card unless he goes
    /// through it one by one.
    func shown(_ inbox: Inbox?, kind: CheckGroup?, cut: ShownList?) -> InboxOrder {
        all(inbox).only(kind).cut(to: cut).folded(except: notes.unfolded, working: notes.working)
    }
}

/// The Inbox page: the ask on show, pushed on the list (`HomeList`) where the list is the page's root (stacked), or
/// alone beside the list (open). A tap runs through the store's action and the ask stays, as its own result, until he
/// moves on; nothing here decides whether a thing happened.
struct InboxScreen: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    /// The bars are in a side column and the ask is the page: the toast is then the column's capsule, the same state.
    @State private var inSideColumn = false

    var body: some View {
        @Bindable var router = router
        let order = shownOrder(router.asks.kind)
        NavigationStack(path: $router.inboxPath) {
            Group {
                if router.pose == .stacked {
                    HomeList().shellBar("")
                        .reportsSideColumn($inSideColumn)
                        .saidBackToast(inSideColumn: inSideColumn)
                } else {
                    ask(order)
                }
            }
            .navigationDestination(for: AppRouter.InboxPage.self) { _ in ask(order) }
        }
        // Ask Life's cut of the asks is of every kind: the asks it named show whatever kind he kept to.
        .onChange(of: router.cut(of: .checks)) { _, cut in if cut != nil { router.asks.kind = nil } }
        // Above the asks, so a read that takes his ask away (his answer was the last) never closes it before it does.
        .askSheets($router.asks.notes) { leave($0, keep: false) }
        // The moves' list is the list: a card of another kind goes back to it first.
        .onChange(of: router.asks.kind) { _, kind in if kind == .yourMove { router.inboxPath = [] } }
        // Folded with an ask on show it stays on show, pushed on the list; open, the ask is the page's root itself.
        .onChange(of: router.pose) { _, pose in
            let isAskPushed = pose == .stacked && router.tab == .inbox && router.asks.current != nil
            router.inboxPath = isAskPushed ? [.ask] : []
        }
        // The chosen kind has no ask left: the whole list again, so the filter never rests on a kind that is gone.
        .onChange(of: all.kinds) { _, kinds in
            if let kind = router.asks.kind, !kinds.contains(kind) { router.asks.kind = nil }
            // The guesses' card left with its last row: the next guesses start clean, not beside old answered rows.
            if !kinds.contains(.guessedPerson) {
                (router.asks.notes.guesses, router.asks.notes.guessed) = ([], [:])
                router.asks.notes.working[.guessedPerson] = nil
            }
        }
        // An answer that came back refused is on show again, with its reason above the answers.
        .onChange(of: refusedRef) { _, ref in
            if let ref { (router.asks.current, router.asks.kind) = (shownOrder(nil).check(on: ref)?.ref, nil) }
        }
        .onChange(of: life.openedCard, initial: true) { _, opening in
            guard let opening else { return }
            // A push's ask may be of another kind: the whole list, with it on show.
            router.asks.kind = nil
            // A push's ask is shown alone: its kind one by one, even if a read later would fold it.
            if let check = opening.check { router.asks.notes.unfolded.insert(check.bulkKind) }
            router.open(ask: shownOrder(nil).check(on: opening.check?.ref)?.ref)
            router.asks.notice =
                opening.wasAnswered ? "Already answered, here or elsewhere. This is the next one." : nil
            life.clearOpenedCard()
        }
    }

    /// The ask on show, pushed on the list, with its pager: the question is the biggest line, so no title here.
    private func ask(_ order: InboxOrder) -> some View {
        ReadScreen(
            shown: shown, stamp: life.inbox.stamp, marks: .readsAndAgents, retry: { await life.refreshInbox() },
            loading: { InboxSkeleton() }, empty: { InboxZero() },
            content: { _ in card(order) }
        )
        // The first card cross-fades in over the skeleton.
        .motion(Motion.standard, value: life.inboxOnShow == nil)
        .background(Palette.bg)
        // Declared before the Pendant: a vertical bar stacks trailing items bottom-up, so the order puts this one under
        // it; `sharedBackgroundVisibility(.hidden)` keeps it out of its capsule.
        .toolbar {
            // Only while there is something to undo: an empty capsule still took the column's room, and the column put
            // the Pendant's neighbours in an overflow menu (seen in `design:shots`).
            let said = life.saidBack?.undo == nil ? nil : life.saidBack
            if inSideColumn, let said, #available(iOS 27.1, *) {
                ToolbarItem(placement: .topBarTrailing) {
                    // A project he parked from a card (`saidBack`).
                    ColumnToast(answered: said.words) { life.undoing(said)?() }
                }
                .sharedBackgroundVisibility(.hidden).axisBehavior(.verticalPreferred)
            }
        }
        .shellBar("")
        .reportsSideColumn($inSideColumn)
        // What he just answered or parked, said back; in the side column, the toast is the column's capsule.
        .saidBackToast(inSideColumn: inSideColumn)
    }

    /// The inbox read as shown, except that his tap's result, or the ask the create sheet answers, stays up whatever the
    /// read did since: the inbox emptied (his answer was the last card) or its read failed. Only a new pairing, which
    /// clears the inbox, takes it away. A read on screen, fresh or stale, shows as it is: its note stays over his tap.
    private var shown: ReadState<Inbox>.Shown {
        guard router.asks.notes.taken != nil || router.asks.notes.creating != nil, life.inboxShown.onScreen == nil,
            let inbox = life.inboxOnShow
        else { return life.inboxShown }
        return .loaded(inbox)
    }

    /// The ask whose answer Life refused, back in the order.
    private var refusedRef: String? {
        all.checks.first { check in
            if case .failed = life.state(of: .answer(ref: check.ref)) { true } else { false }
        }?.ref
    }

    /// On from the ask he answered or kept for later: the next one.
    private func leave(_ taken: Taken, keep: Bool) {
        life.forget(taken.key)
        router.asks.notice = nil
        if keep { router.asks.deferred.append(taken.check.ref) }
        // A new matter whose goal he edited still waits for Start or Dismiss: back to its card.
        (router.asks.notes.taken, router.asks.current) = (
            nil, taken.staysOpen ? taken.check.ref : shownOrder(router.asks.kind).next(of: taken.later)
        )
    }

    private var all: InboxOrder { router.asks.all(life.inboxOnShow) }

    private func shownOrder(_ kind: CheckGroup?) -> InboxOrder {
        router.asks.shown(life.inboxOnShow, kind: kind, cut: router.cut(of: .checks))
    }

    /// The ask on show, or his tap's result in its place: one arrangement for both.
    @ViewBuilder private func card(_ order: InboxOrder) -> some View {
        @Bindable var router = router
        if let check = router.asks.notes.shownCheck ?? order.check(on: router.asks.current) {
            CardView(
                check: check, checks: order.checks, bulk: order.bulk, current: $router.asks.current,
                notes: $router.asks.notes, notice: router.asks.notice, leave: leave)
        } else {
            InboxZero()
        }
    }
}

/// Nothing waits.
private struct InboxZero: View {
    var body: some View {
        Text("Nothing\nto answer.").font(.statusWord).foregroundStyle(Palette.fg).lit()
            .padding(.horizontal, Metrics.gutter)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .readingWidth()
    }
}

/// The inbox is first read, with no cache and no card from a notification: one card's shape in its place, no words (its
/// matter's pill, the question's two lines, its tile, the filled answer, two quiet ones), so the card lands where its
/// shape stood.
private struct InboxSkeleton: View {
    var body: some View {
        GeometryReader { box in
            VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
                Placeholder(width: box.size.width * 0.6, height: 36, radius: 18).padding(.bottom, Metrics.Spacing.xs)
                VStack(alignment: .leading, spacing: 10) {
                    Placeholder(width: box.size.width * 0.88, height: 26, radius: 9)
                    Placeholder(width: box.size.width * 0.56, height: 26, radius: 9)
                }
                Placeholder(height: 150, radius: Metrics.Radius.card).padding(.top, Metrics.Spacing.s)
                Spacer(minLength: 0)
                Placeholder(height: 54)
                HStack(spacing: Metrics.Spacing.s) {
                    Placeholder(height: 44)
                    Placeholder(height: 44)
                }
            }
        }
        .padding(.horizontal, Metrics.Spacing.s).padding(.top, Metrics.Spacing.m).padding(.bottom, Metrics.Spacing.s)
        .readingWidth()
        .accessibilityElement().accessibilityLabel("Reading your inbox")
    }
}
