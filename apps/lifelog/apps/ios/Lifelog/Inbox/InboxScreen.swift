import LifeConnector
import SwiftUI

/// The home tab: the asks waiting on him, as a list and one ask at a time, what blocks first. Two columns, as Matters:
/// the list and the ask, side by side on a regular width, one at a time on a compact one (the ask by default; the
/// system's Back is the list). A tap runs through the store's action and the ask stays, as its own result, until he moves
/// on; nothing here decides whether a thing happened.
struct InboxScreen: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// The bars are in a side column and the ask is one pane: the toast is then the column's capsule, the same state.
    @State private var inSideColumn = false

    @State private var notes = CardNotes()
    /// Asks he kept for later: shown after the others, until the app closes.
    @State private var deferred: [String] = []
    @State private var current: String?
    /// The kind of ask the list and the pager keep to; nil is everything. Not stored: it ends with the screen.
    @State private var kind: CheckGroup?
    @State private var notice: String?
    @State private var visibility = NavigationSplitViewVisibility.all
    /// The widths of the split view and of the ask's column: the list is beside the ask only when the ask has less.
    @State private var widths = (whole: CGFloat.zero, ask: CGFloat.zero)

    var body: some View {
        @Bindable var router = router
        let order = shownOrder(kind)
        NavigationSplitView(columnVisibility: $visibility, preferredCompactColumn: $router.inboxColumn) {
            CheckList(order: order, chosen: order.check(on: current)?.ref) { ref in
                if let taken = notes.taken { life.forget(taken.key) }
                (current, notes.taken, notice) = (ref, nil, nil)
                router.inboxColumn = .detail
            }
            .background(Palette.bg)
            .navigationSplitViewColumnWidth(min: 280, ideal: 455, max: 455)
            .screenTitle("Inbox", state: waiting)
            // The Pendant and Settings are the ask column's when it is beside the list; the list alone (compact) has them.
            .shellBar("", hasSettings: sizeClass != .regular, hasPendant: sizeClass != .regular)
            .askFilterBar(kinds: all.kinds, kind: $kind)
        } detail: {
            ReadScreen(
                shown: shown, retry: { await life.refreshInbox() },
                loading: { InboxSkeleton() }, empty: { InboxZero() },
                content: { _ in card(order) }
            )
            // The first card cross-fades in over the skeleton.
            .motion(Motion.standard, value: life.inboxOnShow == nil)
            .background(Palette.bg)
            // Alone, the ask has the screen's title over it (the question stays the biggest line); beside the list, the
            // list has it, and the gear and the Pendant.
            .screenTitle(widths.ask < widths.whole - 1 ? nil : "Inbox", state: waiting)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { widths.ask = $0 }
            // Declared before the Pendant and Settings: a vertical bar stacks trailing items bottom-up, so the order puts
            // this one under them; `sharedBackgroundVisibility(.hidden)` keeps it out of their capsule.
            .toolbar {
                if inSideColumn, #available(iOS 27.1, *) {
                    ToolbarItem(placement: .topBarTrailing) {
                        // A held answer, else a project he parked from a card (`saidBack`).
                        let said = life.saidBack?.undo == nil ? nil : life.saidBack
                        ColumnToast(answered: life.latestHeld?.held.label ?? said?.words) {
                            if let held = life.latestHeld { undo(held.ref) } else { said.flatMap(life.undoing)?() }
                        }
                    }
                    .sharedBackgroundVisibility(.hidden).axisBehavior(.verticalPreferred)
                }
            }
            .shellBar("")
            .reportsSideColumn($inSideColumn)
            .navigationBarBackButtonHidden()
            // In the side column, the toast is the column's capsule.
            .heldToast(shows: { _ in !inSideColumn }, undo: undo)
            // A project parked from a card's "Tell the agent…", said back with Undo.
            .saidBackToast(inSideColumn: inSideColumn)
            .toolbar {
                if sizeClass != .regular {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Asks", systemImage: "sidebar.left") { router.inboxColumn = .sidebar }
                    }
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
        // Above the asks, so a read that takes his ask away (his answer was the last) never closes it before it does.
        .askSheets($notes) { leave($0, keep: false) }
        // The chosen kind has no ask left: the whole list again, so the filter never rests on a kind that is gone.
        .onChange(of: all.kinds) { _, kinds in if let kind, !kinds.contains(kind) { self.kind = nil } }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { widths.whole = $0 }
        // An answer that came back refused is on show again, with its reason above the answers.
        .onChange(of: refusedRef) { _, ref in
            if let ref { (current, kind) = (shownOrder(nil).check(on: ref)?.ref, nil) }
        }
        .onChange(of: life.openedCard, initial: true) { _, opening in
            guard let opening else { return }
            // A push's ask may be of another kind: the whole list, with it on show.
            kind = nil
            // A push's ask is shown alone: its kind one by one, even if a read later would fold it.
            if let check = opening.check { notes.unfolded.insert(check.bulkKind) }
            current = shownOrder(nil).check(on: opening.check?.ref)?.ref
            notice =
                opening.wasAnswered ? "Already answered, here or elsewhere. This is the next one." : nil
            notes.taken = nil
            router.inboxColumn = .detail
            life.clearOpenedCard()
        }
    }

    /// The inbox read as shown, except that his tap's result, or the ask the create sheet answers, stays up whatever the
    /// read did since: the inbox emptied (his answer was the last card) or its read failed. Only a new pairing, which
    /// clears the inbox, takes it away.
    private var shown: ReadState<Inbox>.Shown {
        guard notes.taken != nil || notes.creating != nil, let inbox = life.inboxOnShow else { return life.inboxShown }
        return .loaded(inbox)
    }

    /// The title's state, "4 waiting": as the inbox read last said, less his answers (`LifeStore.waiting`).
    private var waiting: String? { life.waiting.flatMap { $0 > 0 ? "\($0) waiting" : nil } }

    /// The ask whose answer Life refused, back in the order.
    private var refusedRef: String? {
        all.checks.first { check in
            if case .failed = life.state(of: .answer(ref: check.ref)) { true } else { false }
        }?.ref
    }

    /// On from the ask he answered or kept for later: the next one.
    private func leave(_ taken: Taken, keep: Bool) {
        life.forget(taken.key)
        notice = nil
        if keep { deferred.append(taken.check.ref) }
        // A new matter whose goal he edited still waits for Start or Dismiss: back to its card.
        (notes.taken, current) = (nil, taken.staysOpen ? taken.check.ref : taken.nextRef)
    }

    /// Undo: the ask is back where it was, and on show.
    private func undo(_ ref: String) {
        life.undo(ref)
        current = shownOrder(kind).check(on: ref)?.ref
    }

    /// What blocks, then what can wait: `Inbox.ordered`, the one rule for the list, the pager, the ask on show and where
    /// an answer leads (`only` keeps the chosen kind of it). The store already left out his answers; the one shown as
    /// his result is no row either.
    private var all: InboxOrder {
        life.inboxOnShow?.ordered(deferred: deferred, except: Set(notes.taken.map { [$0.check.ref] } ?? []))
            ?? InboxOrder()
    }

    /// `all` as shown: of the kind he keeps to, with each kind Life pre-ticks folded into one bulk card unless he goes
    /// through it one by one.
    private func shownOrder(_ kind: CheckGroup?) -> InboxOrder {
        all.only(kind).folded(except: notes.unfolded, working: notes.working)
    }

    /// The ask on show, or his tap's result in its place: one arrangement for both, so the ask's context region stays
    /// as it was until the next ask.
    @ViewBuilder private func card(_ order: InboxOrder) -> some View {
        if let check = notes.shownCheck ?? order.check(on: current) {
            CardView(
                check: check, checks: order.checks, bulk: order.bulk, current: $current, notes: $notes, notice: notice,
                holdsAnswers: true, leave: leave)
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

/// The inbox is first read, with no cache and no card from a notification: one card's shape in its place, no words (the
/// question's two lines, its tile, the filled answer, two quiet ones).
private struct InboxSkeleton: View {
    var body: some View {
        GeometryReader { box in
            VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
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
