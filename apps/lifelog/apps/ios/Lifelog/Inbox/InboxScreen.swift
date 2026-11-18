import LifeConnector
import SwiftUI

/// The home tab: the cards waiting on him, one at a time, most urgent first. A tap runs through the store's action and
/// the card stays, as its own result, until he moves on; nothing here decides whether a thing happened.
struct InboxScreen: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    @State private var taken: Taken?
    /// Cards he kept for later: shown after the others, until the app closes.
    @State private var deferred: [String] = []
    @State private var current: String?
    @State private var notice: String?
    /// What he typed or opened on each card: here, not in the card, so folding or unfolding the phone keeps it.
    @State private var inputs: [String: CardInput] = [:]
    /// The card whose "Same as…" he opened.
    @State private var sameAsRef: String?

    var body: some View {
        Group {
            if let taken {
                let state = life.state(of: taken.key)
                let next = ordered(life.inbox.value).first { $0.ref != taken.check.ref }?.question
                CardArrangement(check: taken.check) {
                    AnswerResultView(taken: taken, state: state, next: next)
                } bar: {
                    ResultButtons(
                        taken: taken, state: state, next: next,
                        retry: { Task { await life.answer(taken.request) } },
                        keepForLater: { leave(taken, keep: true) }, nextCard: { leave(taken, keep: false) })
                }
            } else {
                ReadScreen(
                    shown: life.inbox.shown(isEmpty: { $0.checks.isEmpty }), retry: { await life.refreshInbox() },
                    loading: { CardPlaceholder() }, empty: { InboxZero(agents: working) },
                    content: { _ in card })
            }
        }
        .background(Palette.bg)
        .sheet(item: sameAsCard) { check in
            SameAsSheet(people: check.likelyPeople) { choice in
                switch choice {
                case .person(let id): submit(check, AnswerRequest(ref: check.ref, options: [], person: id))
                case .name(let name): submit(check, AnswerRequest(ref: check.ref, options: [], name: name))
                }
            }
            .presentationPlacement(.trailing)
        }
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

    @ViewBuilder private var card: some View {
        if let check = shownCheck {
            cardView(check)
        } else {
            InboxZero(agents: working)
        }
    }

    /// The card on show: the one he opened, else the most urgent.
    private var shownCheck: Check? {
        let checks = ordered(life.inbox.value)
        return checks.first { $0.ref == current } ?? checks.first
    }

    private func cardView(_ check: Check) -> some View {
        let (position, total) = place(of: check)
        let input = Binding(get: { inputs[check.ref] ?? CardInput() }, set: { inputs[check.ref] = $0 })
        return CardArrangement(check: check) {
            VStack(spacing: 0) {
                if let notice {
                    Text(notice).font(.small).foregroundStyle(Palette.muted).padding(.horizontal, 20).padding(
                        .vertical, 10
                    )
                    .frame(maxWidth: .infinity, alignment: .leading).background(Color.fillTint)
                }
                CheckCard(
                    check: check, position: position, total: total, runtimeName: runtimeName(of: check),
                    openMatter: { router.open(matter: $0) }, input: input
                )
                .id(check.ref)
            }
        } bar: {
            CheckActions(
                check: check, runtimeName: runtimeName(of: check), input: input,
                answer: { submit(check, $0) }, sameAs: { sameAsRef = check.ref })
        }
    }

    /// The card whose "Same as…" he opened: that card, even if the inbox reorders under the sheet; gone with it.
    private var sameAsCard: Binding<Check?> {
        Binding(
            get: { sameAsRef.flatMap { ref in life.inbox.value?.checks.first { $0.ref == ref } } },
            set: { if $0 == nil { sameAsRef = nil } })
    }

    /// Most urgent first, as Life sends them; what he kept for later goes after.
    private func ordered(_ inbox: Inbox?) -> [Check] {
        guard let checks = inbox?.checks else { return [] }
        return checks.filter { !deferred.contains($0.ref) } + checks.filter { deferred.contains($0.ref) }
    }

    private func runtimeName(of check: Check) -> RuntimeName? {
        guard let matter = check.matter?.id else { return nil }
        return life.agents.value?.agents.first { $0.matter?.id == matter && $0.status != .ended }?.runtimeName
    }

    private var working: Int { life.agents.value?.agents.count { $0.status == .running || $0.status == .waiting } ?? 0 }

    /// Where a card stands in the inbox, as "2 of 5".
    private func place(of check: Check) -> (position: Int, total: Int) {
        let checks = ordered(life.inbox.value)
        return ((checks.firstIndex { $0.ref == check.ref } ?? 0) + 1, checks.count)
    }

    private func submit(_ check: Check, _ request: AnswerRequest) {
        let (position, total) = place(of: check)
        notice = nil
        taken = Taken(
            check: check, request: request, position: position, total: total, runtimeName: runtimeName(of: check))
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
