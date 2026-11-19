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
        ReadScreen(
            shown: shown, retry: { await life.refreshInbox() },
            loading: { CardPlaceholder() }, empty: { InboxZero(agents: working) },
            content: { _ in card }
        )
        .background(Palette.bg)
        .sheet(item: sameAsCard) { check in
            SameAsSheet(
                title: "Same as…", people: check.likelyPeople,
                takesNewName: check.namingOption?.takes == .personOrName
            ) { choice in
                if let request = check.answer(naming: choice) { submit(check, request) }
            }
            .sheetStack()
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

    /// The inbox read as shown, except that his tap's result stays up whatever the read did since: the inbox emptied
    /// (his answer was the last card) or its read failed. Only a new pairing, which clears the inbox, takes it away.
    private var shown: ReadState<Inbox>.Shown {
        guard taken != nil, let inbox = life.inbox.value else {
            return life.inbox.shown(isEmpty: { $0.checks.isEmpty })
        }
        return .loaded(inbox)
    }

    /// The card on show, or his tap's result in its place: one arrangement for both, so the card's context region stays
    /// as it was until the next card.
    @ViewBuilder private var card: some View {
        if let check = taken?.check ?? shownCheck {
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
        CardArrangement(check: check) {
            if let taken {
                let state = life.state(of: taken.key)
                AnswerResultView(taken: taken, state: state, next: question(after: taken))
            } else {
                VStack(spacing: 0) {
                    if let notice {
                        Text(notice).font(.small).foregroundStyle(Palette.muted).padding(.horizontal, 20).padding(
                            .vertical, 10
                        )
                        .frame(maxWidth: .infinity, alignment: .leading).background(Color.fillTint)
                    }
                    pager
                }
            }
        } bar: {
            if let taken {
                let state = life.state(of: taken.key)
                ResultButtons(
                    taken: taken, state: state, next: question(after: taken),
                    retry: { Task { await life.answer(taken.request) } },
                    keepForLater: { leave(taken, keep: true) }, nextCard: { leave(taken, keep: false) })
            } else if life.state(of: .answer(ref: check.ref)).isRunning {
                // An answer still running (this screen was rebuilt while its send ran): its busy pill, no second tap.
                Button {
                } label: {
                    Text(check.draft != nil ? "Sending…" : "Saving…")
                }
                .buttonStyle(.pill(.quiet, isBusy: true)).disabled(true)
            } else {
                CheckActions(
                    check: check, runtimeName: runtimeName(of: check), input: input(check.ref),
                    answer: { submit(check, $0) }, sameAs: { sameAsRef = check.ref }
                )
            }
        }
    }

    /// The cards side by side: he swipes left for the next, right to come back, and the next one's edge shows at the right.
    /// Swiping only moves `current`; it never answers, and a card he passes stays where it was.
    private var pager: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 0) {
                    ForEach(ordered(life.inbox.value)) { check in
                        CheckCard(
                            check: check, runtimeName: runtimeName(of: check), openMatter: { router.open(matter: $0) },
                            input: input(check.ref)
                        )
                        .background(Palette.sheet, in: .rect(cornerRadius: Metrics.Radius.card))
                        .padding(.leading, Pager.gap)
                        .containerRelativeFrame(.horizontal) { width, _ in width - Pager.edge - Pager.gap }
                        .id(check.ref)
                    }
                }
                .padding(.trailing, Pager.edge + Pager.gap)
                .scrollTargetLayout()
            }
            .scrollPosition(id: $current, anchor: .leading)
            .scrollTargetBehavior(.viewAligned)
            .scrollIndicators(.hidden)
            // A pager made after his tap's result starts on the first card: put it on the one he is on.
            .onAppear { if let current { proxy.scrollTo(current, anchor: .leading) } }
        }
    }

    private func input(_ ref: String) -> Binding<CardInput> {
        Binding(get: { inputs[ref] ?? CardInput() }, set: { inputs[ref] = $0 })
    }

    /// The card after this one, by its place in the list: nothing after the last.
    private func nextCard(after check: Check) -> Check? {
        let checks = ordered(life.inbox.value)
        return checks.firstIndex { $0.ref == check.ref }.flatMap { checks.dropFirst($0 + 1).first }
    }

    /// The question of the card that comes after his tap's, when one is waiting.
    private func question(after taken: Taken) -> String? {
        ordered(life.inbox.value).first { $0.ref == taken.nextRef }?.question
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
        return life.agents.value?.agents.first { $0.matter?.id == matter && !$0.isOver }?.runtimeName
    }

    private var working: Int { life.agents.value?.agents.count { $0.status == .running || $0.status == .waiting } ?? 0 }

    private func submit(_ check: Check, _ request: AnswerRequest) {
        notice = nil
        taken = Taken(
            check: check, request: request, nextRef: nextCard(after: check)?.ref, runtimeName: runtimeName(of: check))
        Task { await life.answer(request) }
    }

    /// Back to the cards: the next one, or the same card when it still waits on him (a new matter whose goal he edited).
    private func leave(_ taken: Taken, keep: Bool) {
        life.forget(taken.key)
        if keep { deferred.append(taken.check.ref) }
        (self.taken, current) = (nil, taken.staysOpen ? taken.check.ref : taken.nextRef)
    }
}

/// The pager's measures, from the Ask panel: 12 from the sides and between cards, the next card's edge showing 10.
private enum Pager {
    static let gap = Metrics.Spacing.xs * 3
    static let edge = Metrics.Spacing.xs * 2.5
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
