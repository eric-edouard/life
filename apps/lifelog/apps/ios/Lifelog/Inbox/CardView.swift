import LifeConnector
import SwiftUI

/// What he typed on each ask and the answer he gave: kept by the screen that hosts the asks, above the size-class
/// branch, so folding or unfolding the phone keeps both.
struct CardNotes: Equatable {
    var inputs: [String: CardInput] = [:]
    var taken: Taken?
}

/// One ask on show, whoever hosts it (the Inbox, a matter's stack): the ask with its answers, then its result in its
/// place. `checks` are the asks around it, paged by swipe when there are several. A send or a start runs through the
/// store's action and the ask stays, as its own result: it moves on by itself once it worked, and waits for him when it
/// did not. With `holdsAnswers` every other answer is held four seconds for Undo and the next ask is on show at once.
struct CardView: View {
    let check: Check
    let checks: [Check]
    /// The ask under the pager's leading edge: swiping only moves it, never answers.
    @Binding var current: String?
    @Binding var notes: CardNotes
    var notice: String?
    /// The ask's context region beside or below it: a matter's stack gives one, the Inbox none.
    var context: ContextRegion?
    /// Answers that are not a send or a start are held for Undo (the Inbox draws the toast), not shown as a result.
    /// Without it, only his word that a step is done is held (`Taken.isEnding`); the host draws its toast.
    var holdsAnswers = false
    /// Back to what hosts the asks, with the ask he passed (and whether he kept it for later).
    let leave: (Taken, _ keep: Bool) -> Void

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    /// The ask whose "Same as…" he opened.
    @State private var sameAsRef: String?

    var body: some View {
        CardArrangement(
            context: context,
            bar: result.map { taken in
                ResultButtons(
                    taken: taken, state: life.state(of: taken.key),
                    retry: { Task { await life.answer(taken.request) } }, keepForLater: { leave(taken, true) })
            }
        ) {
            if let taken = result {
                AnswerResultView(taken: taken, state: life.state(of: taken.key))
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
        // A send Life refused because someone wrote since: the ask is open again, with her message by its answers.
        .onChange(of: notes.taken != nil && result == nil) { _, isRefused in if isRefused { notes.taken = nil } }
        // A result that worked has said so: the next ask comes by itself.
        .task(id: isDone) {
            guard isDone, let taken = notes.taken else { return }
            try? await Task.sleep(for: .seconds(1.5))
            if !Task.isCancelled { leave(taken, false) }
        }
        .sheet(item: sameAsCard) { check in
            SameAsSheet(
                people: check.likelyPeople,
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
        .motion(Motion.standard, value: checks.map(\.ref))
    }

    /// His tap's result, unless it reopened the ask (a send refused because someone wrote since).
    private var result: Taken? {
        guard let taken = notes.taken else { return nil }
        if case .failed(let failure, _) = life.state(of: taken.key), failure.wrote != nil { return nil }
        return taken
    }

    private var isDone: Bool {
        guard let taken = notes.taken, case .succeeded = life.state(of: taken.key) else { return false }
        return true
    }

    private func input(_ ref: String) -> Binding<CardInput> {
        Binding(get: { notes.inputs[ref] ?? CardInput() }, set: { notes.inputs[ref] = $0 })
    }

    /// The ask whose "Same as…" he opened: that ask, even if the list reorders under the sheet; gone with it.
    private var sameAsCard: Binding<Check?> {
        Binding(
            get: { sameAsRef.flatMap { ref in checks.first { $0.ref == ref } } },
            set: { if $0 == nil { sameAsRef = nil } })
    }

    private func submit(_ check: Check, _ request: AnswerRequest) {
        let taken = Taken(
            check: check, request: request, nextRef: checks.ref(after: check.ref),
            runtimeName: life.runtimeName(of: check))
        if holdsAnswers && taken.isHeld {
            life.hold(request, as: taken.heldWords)
            current = taken.nextRef
        } else if taken.isEnding {
            // Off the Inbox too (a matter's stack): held for Undo, which the host's toast offers, then sent.
            life.hold(request, as: taken.heldWords)
            leave(taken, false)
        } else {
            notes.taken = taken
            Task { await life.answer(request) }
        }
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
        page
            // A pushed screen: Back, then the Pendant.
            .shellBar("", hasSettings: false)
    }

    @ViewBuilder private var page: some View {
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
