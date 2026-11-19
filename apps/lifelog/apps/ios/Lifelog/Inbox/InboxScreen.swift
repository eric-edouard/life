import LifeConnector
import SwiftUI

/// The home tab: the cards waiting on him, one at a time, most urgent first. A tap runs through the store's action and
/// the card stays, as its own result, until he moves on; nothing here decides whether a thing happened.
struct InboxScreen: View {
    @Environment(LifeStore.self) private var life

    @State private var notes = CardNotes()
    /// Cards he kept for later: shown after the others, until the app closes.
    @State private var deferred: [String] = []
    @State private var current: String?
    @State private var notice: String?

    var body: some View {
        ReadScreen(
            shown: shown, retry: { await life.retryInbox() },
            loading: { CardPlaceholder() }, empty: { InboxZero() },
            content: { _ in card }
        )
        .background(Palette.bg)
        .onChange(of: life.openedCard, initial: true) { _, opening in
            guard let opening else { return }
            current = opening.check?.ref
            notice =
                opening.wasAnswered ? "Already answered, here or elsewhere. This is the next one." : nil
            notes.taken = nil
            life.clearOpenedCard()
        }
    }

    /// The inbox read as shown, except that his tap's result stays up whatever the read did since: the inbox emptied
    /// (his answer was the last card) or its read failed. Only a new pairing, which clears the inbox, takes it away.
    private var shown: ReadState<Inbox>.Shown {
        if let push = life.pushRead { return push.phase == .loaded ? .loading : push.shown() }
        guard notes.taken != nil, let inbox = life.inbox.value else {
            return life.inbox.shown(isEmpty: { $0.checks.isEmpty })
        }
        return .loaded(inbox)
    }

    /// The card on show, or his tap's result in its place: one arrangement for both, so the card's context region stays
    /// as it was until the next card.
    @ViewBuilder private var card: some View {
        if let check = notes.taken?.check ?? pages.check(on: current) {
            CardView(check: check, pages: pages, current: $current, notes: $notes, notice: notice) { taken, keep in
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

    /// What blocks, the boundary, what improves: `Inbox.pages`, the one rule for the pager, the card on show and where
    /// an answer leads.
    private var pages: [InboxPage] { life.inbox.value?.pages(deferred: deferred) ?? [] }
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

/// A card's shape while the inbox is first read.
private struct CardPlaceholder: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Placeholder(width: 160, height: 12)
            HStack {
                Placeholder(width: 120, height: 36); Placeholder(width: 150, height: 36)
            }
            Placeholder(height: 26)
            Placeholder(width: 220, height: 26)
            Placeholder(height: 150)
            Spacer()
        }
        .padding(20)
        .accessibilityLabel("Loading the inbox")
    }
}
