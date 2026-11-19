import LifeConnector
import SwiftUI

/// What he typed on each ask and the answer he gave: kept by the screen that hosts the asks, above the size-class
/// branch, so folding or unfolding the phone keeps both.
struct CardNotes: Equatable {
    var inputs: [String: CardInput] = [:]
    var taken: Taken?
}

/// One ask on show, whoever hosts it (the Inbox, a matter's stack): the ask with its answers, then its result in its
/// place. `pages` are the asks around it (and the boundary panel, "The rest can wait.", a page of its own, swiped past
/// like a card, never an answer), paged by swipe when there are several; a tap runs through the store's action and the
/// ask stays, as its own result, until he moves on.
struct CardView: View {
    let check: Check
    let pages: [InboxPage]
    /// The ask under the pager's leading edge: swiping only moves it, never answers.
    @Binding var current: String?
    @Binding var notes: CardNotes
    var notice: String?
    /// Back to what hosts the asks, with the ask he passed (and whether he kept it for later).
    let leave: (Taken, _ keep: Bool) -> Void

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    /// The ask whose "Same as…" he opened.
    @State private var sameAsRef: String?

    var body: some View {
        CardArrangement(check: check) {
            if let taken = notes.taken {
                AnswerResultView(taken: taken, state: life.state(of: taken.key), next: question(after: taken))
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
        } bar: {
            if let taken = notes.taken {
                ResultButtons(
                    taken: taken, state: life.state(of: taken.key), next: question(after: taken),
                    retry: { Task { await life.answer(taken.request) } },
                    keepForLater: { leave(taken, true) }, nextCard: { leave(taken, false) })
            } else if life.state(of: .answer(ref: check.ref)).isRunning {
                // An answer still running (this screen was rebuilt while its send ran): its busy pill, no second tap.
                Button {
                } label: {
                    Text(check.draft != nil ? "Sending…" : "Saving…")
                }
                .buttonStyle(.pill(.quiet, isBusy: true)).disabled(true)
            } else if pages.page(on: current) == .boundary {
                EmptyView()
            } else {
                CheckActions(
                    check: check, runtimeName: runtimeName(of: check), input: input(check.ref),
                    answer: { submit(check, $0) }, sameAs: { sameAsRef = check.ref }
                )
            }
        }
        .sheet(item: sameAsCard) { check in
            SameAsSheet(
                title: check.namingOption?.label ?? "Same as…", people: check.likelyPeople,
                takesNewName: check.namingOption?.takes == .personOrName
            ) { choice in
                if let request = check.answer(naming: choice) { submit(check, request) }
            }
            .sheetStack()
        }
    }

    /// The pages side by side: he swipes left for the next, right to come back, and the next one's edge shows at the right.
    /// An ask alone has no edge to show. A page he passes stays where it was.
    private var pager: some View {
        let edge = pages.count > 1 ? Pager.edge : 0
        return ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 0) {
                    ForEach(pages, id: \.id) { page in
                        switch page {
                        case .boundary:
                            panel(edge: edge) { BoundaryPanel() }.id(page.id)
                        case .ask(let check):
                            panel(edge: edge) {
                                CheckCard(
                                    check: check, runtimeName: runtimeName(of: check),
                                    openMatter: { router.open(matter: $0) },
                                    confirm: { request in Task { await life.answer(request) } }, input: input(check.ref)
                                )
                            }
                            .id(page.id)
                        }
                    }
                }
                .padding(.trailing, edge + Pager.gap)
                .scrollTargetLayout()
            }
            .scrollPosition(id: $current, anchor: .leading)
            .scrollTargetBehavior(.viewAligned)
            .scrollIndicators(.hidden)
            .clipped()
            // A pager made after his tap's result starts on the first ask: put it on the one he is on.
            .onAppear { if let current { proxy.scrollTo(current, anchor: .leading) } }
        }
    }

    private func panel(edge: CGFloat, @ViewBuilder _ content: () -> some View) -> some View {
        content()
            .background(Palette.sheet, in: .rect(cornerRadius: Metrics.Radius.card))
            .padding(.leading, Pager.gap)
            .containerRelativeFrame(.horizontal) { width, _ in width - edge - Pager.gap }
    }

    private func input(_ ref: String) -> Binding<CardInput> {
        Binding(get: { notes.inputs[ref] ?? CardInput() }, set: { notes.inputs[ref] = $0 })
    }

    /// The question of the ask after his tap's, when one is waiting.
    private func question(after taken: Taken) -> String? { pages.checks.first { $0.ref == taken.nextRef }?.question }

    /// The ask whose "Same as…" he opened: that ask, even if the list reorders under the sheet; gone with it.
    private var sameAsCard: Binding<Check?> {
        Binding(
            get: { sameAsRef.flatMap { ref in pages.checks.first { $0.ref == ref } } },
            set: { if $0 == nil { sameAsRef = nil } })
    }

    private func runtimeName(of check: Check) -> RuntimeName? {
        guard let matter = check.matter?.id else { return nil }
        return life.agents.value?.agents.first { $0.matter?.id == matter && !$0.isOver }?.runtimeName
    }

    private func submit(_ check: Check, _ request: AnswerRequest) {
        // After the last ask that blocks, the next page is the boundary, not the first that can wait.
        notes.taken = Taken(
            check: check, request: request, nextRef: pages.id(after: check.ref), runtimeName: runtimeName(of: check))
        Task { await life.answer(request) }
    }
}

/// The pager's measures, from the Ask panel: 12 from the sides and between cards, the next card's edge showing 10.
private enum Pager {
    static let gap = Metrics.Spacing.xs * 3
    static let edge = Metrics.Spacing.xs * 2.5
}

/// "The rest can wait.": between the asks that block him and the ones that only improve what Life knows.
private struct BoundaryPanel: View {
    var body: some View {
        Text("The rest\ncan wait.").font(.statusWord).foregroundStyle(Palette.fg).lit()
            .padding(Metrics.Spacing.xs * 4.5)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
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
        if let check = notes.taken?.check.ref == ref ? notes.taken?.check : source.first(where: { $0.ref == ref }) {
            CardView(check: check, pages: [.ask(check)], current: $current, notes: $notes) { taken, _ in
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
