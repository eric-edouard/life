import LifeConnector
import SwiftUI

/// The home tab: the cards waiting on him, one at a time, most urgent first. A tap runs through the store's action and
/// the card stays, as its own result, until he moves on; nothing here decides whether a thing happened.
struct InboxScreen: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    @State private var taken: Taken?
    /// Cards he kept for later: shown after the others, until the inbox changes under them.
    @State private var deferred: [String] = []
    @State private var current: String?
    @State private var notice: String?

    var body: some View {
        Group {
            if let taken {
                AnswerResultView(
                    taken: taken, state: life.state(of: taken.key),
                    next: ordered(life.inbox.value).first { $0.ref != taken.check.ref }?.question,
                    retry: { Task { await life.answer(taken.request) } },
                    keepForLater: { leave(taken, keep: true) }, nextCard: { leave(taken, keep: false) })
            } else {
                ReadScreen(
                    shown: life.inbox.shown(isEmpty: { $0.checks.isEmpty }), retry: { await life.refreshInbox() },
                    loading: { CardPlaceholder() }, empty: { InboxZero(agents: working) },
                    content: { inbox in card(in: inbox) })
            }
        }
        .background(Palette.bg)
        .onChange(of: life.openedCard, initial: true) { _, opening in
            guard let opening else { return }
            current = opening.check?.ref
            notice =
                opening.wasAnswered ? "That card was already answered, here or elsewhere. This is the next one." : nil
            taken = nil
            life.clearOpenedCard()
        }
        .onChange(of: router.focusedCard, initial: true) { _, ref in
            guard let ref else { return }
            (current, taken) = (ref, nil)
            router.focusedCard = nil
        }
    }

    @ViewBuilder private func card(in inbox: Inbox) -> some View {
        let checks = ordered(inbox)
        let index = checks.firstIndex { $0.ref == current } ?? 0
        if let check = checks.indices.contains(index) ? checks[index] : nil {
            cardView(check, index: index, count: checks.count)
        } else {
            InboxZero(agents: working)
        }
    }

    private func cardView(_ check: Check, index: Int, count: Int) -> some View {
        VStack(spacing: 0) {
            if let notice {
                Text(notice).font(.small).foregroundStyle(Palette.muted).padding(.horizontal, 20).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading).background(Color.fillTint)
            }
            CheckCard(
                check: check, position: index + 1, total: count, provider: provider(of: check),
                answer: { request in submit(check, request, position: index + 1, total: count) },
                openMatter: { router.open(matter: $0) }
            )
            .id(check.ref)
        }
    }

    /// Most urgent first, as Life sends them; what he kept for later goes after.
    private func ordered(_ inbox: Inbox?) -> [Check] {
        guard let checks = inbox?.checks else { return [] }
        return checks.filter { !deferred.contains($0.ref) } + checks.filter { deferred.contains($0.ref) }
    }

    private func provider(of check: Check) -> Provider? {
        guard let matter = check.matter?.id else { return nil }
        return life.agents.value?.agents.first { $0.matter?.id == matter && $0.status != .ended }?.provider
    }

    private var working: Int { life.agents.value?.agents.count { $0.status == .running || $0.status == .waiting } ?? 0 }

    private func submit(_ check: Check, _ request: AnswerRequest, position: Int, total: Int) {
        notice = nil
        taken = Taken(check: check, request: request, position: position, total: total, provider: provider(of: check))
        Task { await life.answer(request) }
    }

    private func leave(_ taken: Taken, keep: Bool) {
        life.forget(taken.key)
        if keep { deferred.append(taken.check.ref) }
        (self.taken, current) = (nil, nil)
    }
}

/// Nothing waits: where the agents stand, and how the next card will reach him.
private struct InboxZero: View {
    let agents: Int
    @Environment(AppRouter.self) private var router

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
            Spacer()
        }
        .padding(.horizontal, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
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
