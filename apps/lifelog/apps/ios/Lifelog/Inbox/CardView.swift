import LifeConnector
import SwiftUI

/// What he typed on each ask and the answer he gave: kept by the screen that hosts the asks, above the size-class
/// branch, so folding or unfolding the phone keeps both.
struct CardNotes: Equatable {
    var inputs: [String: CardInput] = [:]
    var taken: Taken?
}

/// One ask on show, whoever hosts it (the Inbox, a matter's stack): the ask with its answers, then its result in its
/// place. `checks` are the asks around it, paged by swipe when there are several; a tap runs through the store's action
/// and the ask stays, as its own result, until he moves on.
struct CardView: View {
    let check: Check
    let checks: [Check]
    /// The ask under the pager's leading edge: swiping only moves it, never answers.
    @Binding var current: String?
    @Binding var notes: CardNotes
    var notice: String?
    /// The ask's context region beside or below it: a matter's stack gives one, the Inbox none.
    var context: ContextRegion?
    /// Back to what hosts the asks, with the ask he passed (and whether he kept it for later).
    let leave: (Taken, _ keep: Bool) -> Void

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    /// The ask whose "Same as…" he opened.
    @State private var sameAsRef: String?

    var body: some View {
        CardArrangement(
            context: context,
            bar: notes.taken.map { taken in
                ResultButtons(
                    taken: taken, state: life.state(of: taken.key), next: question(after: taken),
                    retry: { Task { await life.answer(taken.request) } },
                    keepForLater: { leave(taken, true) }, nextCard: { leave(taken, false) })
            }
        ) {
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

    /// The asks side by side, one page each: he swipes left for the next, right to come back, and the next one's edge shows
    /// at the right. The scroll view is one page wide and its clip is off, so a page's width is the paging step and the
    /// edge still shows. An ask alone has no edge. An ask he passes stays where it was.
    private var pager: some View {
        let edge = checks.count > 1 ? Pager.edge : 0
        return GeometryReader { box in
            ScrollViewReader { proxy in
                ScrollView(.horizontal) {
                    LazyHStack(spacing: 0) {
                        ForEach(checks) { check in
                            CheckCard(
                                check: check, runtimeName: life.runtimeName(of: check),
                                openMatter: { router.open(matter: $0) },
                                input: input(check.ref),
                                isBusy: life.state(of: .answer(ref: check.ref)).isRunning,
                                answer: { submit(check, $0) }, sameAs: { sameAsRef = check.ref }
                            )
                            .background(Palette.sheet, in: .rect(cornerRadius: Metrics.Radius.card))
                            .padding(.leading, Pager.gap)
                            .containerRelativeFrame(.horizontal)
                            .id(check.ref)
                        }
                    }
                    .scrollTargetLayout()
                }
                .frame(width: box.size.width - edge - Pager.gap)
                .scrollClipDisabled()
                .scrollPosition(id: $current, anchor: .leading)
                .scrollTargetBehavior(.paging)
                .scrollIndicators(.hidden)
            }
        }
        .clipped()
    }

    private func input(_ ref: String) -> Binding<CardInput> {
        Binding(get: { notes.inputs[ref] ?? CardInput() }, set: { notes.inputs[ref] = $0 })
    }

    /// The question of the ask after his tap's, when one is waiting.
    private func question(after taken: Taken) -> String? { checks.first { $0.ref == taken.nextRef }?.question }

    /// The ask whose "Same as…" he opened: that ask, even if the list reorders under the sheet; gone with it.
    private var sameAsCard: Binding<Check?> {
        Binding(
            get: { sameAsRef.flatMap { ref in checks.first { $0.ref == ref } } },
            set: { if $0 == nil { sameAsRef = nil } })
    }

    private func submit(_ check: Check, _ request: AnswerRequest) {
        notes.taken = Taken(
            check: check, request: request, nextRef: checks.ref(after: check.ref),
            runtimeName: life.runtimeName(of: check))
        Task { await life.answer(request) }
    }
}

/// The pager's measures, from the Ask panel: 12 from the sides and between cards, the next card's edge showing 10.
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
