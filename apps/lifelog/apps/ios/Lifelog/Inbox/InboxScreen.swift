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
        let order = all.only(kind)
        NavigationSplitView(columnVisibility: $visibility, preferredCompactColumn: $router.inboxColumn) {
            CheckList(order: order, chosen: order.check(on: current)?.ref) { ref in
                if let taken = notes.taken { life.forget(taken.key) }
                (current, notes.taken, notice) = (ref, nil, nil)
                router.inboxColumn = .detail
            }
            .background(Palette.bg)
            .navigationSplitViewColumnWidth(min: 280, ideal: 455, max: 455)
            // The Pendant and Settings are the ask column's when it is beside the list; the list alone (compact) has them.
            .shellBar(
                widths.ask < widths.whole - 1 ? "Inbox" : "", hasSettings: sizeClass != .regular,
                hasPendant: sizeClass != .regular
            )
            .askFilterBar(kinds: all.kinds, kind: $kind)
        } detail: {
            ReadScreen(
                shown: shown, retry: { await life.retryInbox() },
                loading: { InboxLoading() }, empty: { InboxZero() },
                content: { _ in card(order) }
            )
            .background(Palette.bg)
            // Nothing above the question: no title; the gear and the Pendant are the list's when it is beside.
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { widths.ask = $0 }
            // Declared before the Pendant and Settings: a vertical bar stacks trailing items bottom-up, so the order puts
            // this one under them; `sharedBackgroundVisibility(.hidden)` keeps it out of their capsule.
            .toolbar {
                if inSideColumn, #available(iOS 27.1, *) {
                    ToolbarItem(placement: .topBarTrailing) {
                        ColumnToast(answered: life.latestHeld?.held.label) { life.latestHeld.map { undo($0.ref) } }
                    }
                    .sharedBackgroundVisibility(.hidden).axisBehavior(.verticalPreferred)
                }
            }
            .shellBar("")
            .reportsSideColumn($inSideColumn)
            .navigationBarBackButtonHidden()
            // In the side column, the toast is the column's capsule.
            .heldToast(shows: { _ in !inSideColumn }, undo: undo)
            .toolbar {
                if sizeClass != .regular {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Asks", systemImage: "sidebar.left") { router.inboxColumn = .sidebar }
                    }
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
        // The chosen kind has no ask left: the whole list again, so the filter never rests on a kind that is gone.
        .onChange(of: all.kinds) { _, kinds in if let kind, !kinds.contains(kind) { self.kind = nil } }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { widths.whole = $0 }
        // An answer that came back refused is on show again, with its reason above the answers.
        .onChange(of: refusedRef) { _, ref in if let ref { (current, kind) = (ref, nil) } }
        .onChange(of: life.openedCard, initial: true) { _, opening in
            guard let opening else { return }
            // A push's ask may be of another kind: the whole list, with it on show.
            kind = nil
            current = opening.check?.ref
            notice =
                opening.wasAnswered ? "Already answered, here or elsewhere. This is the next one." : nil
            notes.taken = nil
            router.inboxColumn = .detail
            life.clearOpenedCard()
        }
    }

    /// The inbox read as shown, except that his tap's result stays up whatever the read did since: the inbox emptied
    /// (his answer was the last card) or its read failed. Only a new pairing, which clears the inbox, takes it away.
    private var shown: ReadState<Inbox>.Shown {
        guard notes.taken != nil, let inbox = life.inboxOnShow else { return life.inboxShown }
        return .loaded(inbox)
    }

    /// The ask whose answer Life refused, back in the order.
    private var refusedRef: String? {
        all.checks.first { check in
            if case .failed = life.state(of: .answer(ref: check.ref)) { true } else { false }
        }?.ref
    }

    /// Undo: the ask is back where it was, and on show.
    private func undo(_ ref: String) {
        life.undo(ref)
        current = ref
    }

    /// What blocks, then what can wait: `Inbox.ordered`, the one rule for the list, the pager, the ask on show and where
    /// an answer leads (`only` keeps the chosen kind of it). An answer held, in flight or shown as his result is no row.
    private var all: InboxOrder {
        life.inboxOnShow?.ordered(
            deferred: deferred, except: life.answersUnderWay.union(notes.taken.map { [$0.check.ref] } ?? []))
            ?? InboxOrder()
    }

    /// The ask on show, or his tap's result in its place: one arrangement for both, so the ask's context region stays
    /// as it was until the next ask.
    @ViewBuilder private func card(_ order: InboxOrder) -> some View {
        if let check = notes.taken?.check ?? order.check(on: current) {
            CardView(
                check: check, checks: order.checks, current: $current, notes: $notes, notice: notice,
                holdsAnswers: true
            ) {
                taken, keep in
                life.forget(taken.key)
                notice = nil
                if keep { deferred.append(taken.check.ref) }
                // A new matter whose goal he edited still waits for Start or Dismiss: back to its card.
                (notes.taken, current) = (nil, taken.staysOpen ? taken.check.ref : taken.nextRef)
            }
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

/// The inbox is first read: a spinner and one line.
private struct InboxLoading: View {
    var body: some View {
        VStack(spacing: 12) {
            Spinner().foregroundStyle(Palette.fg)
            Text("Reading your inbox…").font(.note).foregroundStyle(Palette.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}
