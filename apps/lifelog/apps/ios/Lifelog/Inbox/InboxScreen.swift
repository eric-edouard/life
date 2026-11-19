import LifeConnector
import SwiftUI

/// The home tab: the cards waiting on him, one at a time, most urgent first. A tap runs through the store's action and
/// the card stays, as its own result, until he moves on; nothing here decides whether a thing happened.
struct InboxScreen: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    @State private var notes = AskNotes()
    /// Cards he kept for later: shown after the others, until the app closes.
    @State private var deferred: [String] = []
    @State private var current: String?
    @State private var notice: String?

    var body: some View {
        ReadScreen(
            shown: shown, retry: { await life.refreshInbox() },
            loading: { CardPlaceholder() }, empty: { InboxZero(agents: working) },
            content: { _ in card }
        )
        .background(Palette.bg)
        .onChange(of: life.openedCard, initial: true) { _, opening in
            guard let opening else { return }
            current = opening.check?.ref
            notice =
                opening.wasAnswered ? "That card was already answered, here or elsewhere. This is the next one." : nil
            notes.taken = nil
            life.clearOpenedCard()
        }
    }

    /// The inbox read as shown, except that his tap's result stays up whatever the read did since: the inbox emptied
    /// (his answer was the last card) or its read failed. Only a new pairing, which clears the inbox, takes it away.
    private var shown: ReadState<Inbox>.Shown {
        guard notes.taken != nil, let inbox = life.inbox.value else {
            return life.inbox.shown(isEmpty: { $0.checks.isEmpty })
        }
        return .loaded(inbox)
    }

    /// The card on show, or his tap's result in its place: one arrangement for both, so the card's context region stays
    /// as it was until the next card.
    @ViewBuilder private var card: some View {
        if let check = notes.taken?.check ?? shownCheck {
            AskView(check: check, cards: ordered, current: $current, notes: $notes, notice: notice) { taken, keep in
                life.forget(taken.key)
                if keep { deferred.append(taken.check.ref) }
                (notes.taken, current) = (nil, taken.nextRef)
            }
        } else {
            InboxZero(agents: working)
        }
    }

    /// The card on show: the one he opened, else the most urgent.
    private var shownCheck: Check? { ordered.first { $0.ref == current } ?? ordered.first }

    /// Most urgent first, as Life sends them; what he kept for later goes after.
    private var ordered: [Check] {
        guard let checks = life.inbox.value?.checks else { return [] }
        return checks.filter { !deferred.contains($0.ref) } + checks.filter { deferred.contains($0.ref) }
    }

    private var working: Int { life.agents.value?.agents.count { $0.status == .running || $0.status == .waiting } ?? 0 }
}

/// Nothing waits: where the agents stand, and how the next card will reach him.
private struct InboxZero: View {
    let agents: Int
    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Spacer()
            Text("Nothing\nneeds you.").font(.statusWord).foregroundStyle(Palette.fg).lit()
            Text(
                "\(agents == 0 ? "No agent is working" : agents == 1 ? "One agent is working" : "\(agents) agents are working"). The next card reaches you by push, the moment it exists."
            )
            .font(.body15).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            if agents > 0 {
                Button("See what they are doing") {
                    router.showsAgentsOnly = true
                    router.tab = .matters
                }
                .buttonStyle(.pill(.quiet)).padding(.top, 8)
            }
            Spacer()
            if let count = life.inbox.value?.toConfirm, count > 0 {
                RowGroup {
                    Button {
                        router.inboxPath.append(.toConfirm)
                    } label: {
                        Row(title: "\(count) to confirm, when you like") { RowValue() }
                    }
                    .buttonStyle(.plain)
                }
                .transition(.opacity)
            }
            Spacer()
        }
        .padding(.horizontal, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .readingWidth()
        .motion(Motion.standard, value: life.inbox.value?.toConfirm)
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
