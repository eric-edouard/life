import LifeConnector
import SwiftUI

/// One ask of his thread as the design system's item: Life gives the state (`ThreadAsk.State`), the phone adds only
/// "queued" (his answer waits for Life to be back). Unfolded, an ask he can answer is an `AskCard`; one he cannot is
/// its question; a send he may undo is a `SentLine`.
struct ItemRow: View {
    let ask: ThreadAsk
    @Environment(LifeStore.self) private var life
    @State private var isOpen = false
    @State private var words = ""
    @State private var isConfirmingUndo = false
    /// The answer he tapped last: the one that shows its spinner while Life works, and "Not sent" if it failed.
    @State private var tapped: String?
    /// The option that takes a person, while his directory's picker is open.
    @State private var pickingFor: String?
    /// His "How am I doing?" was answered or closed here: the row goes.
    @State private var isRated = false

    private var key: LifeStore.ActionKey { .answer(ref: ask.ref) }
    private var action: ActionState<ActionProof> { life.state(of: key) }
    private var isQueued: Bool { life.isQueued(ask.ref) }

    private var state: ItemState {
        if isQueued { return .queued }
        return switch ask.state {
        case .needsYou, .unknown: .needsYou
        case .later: .later
        case .underWay: .underWay(progress: 0, estimate: nil)
        case .waitingOnSomeone: .waitingOnSomeone
        case .settled: .settled
        case .outdated: .outdated
        }
    }

    /// What the row says under its title, from what the wire carries.
    private var line: String? {
        if isQueued { return "Goes when you're back" }
        return switch ask.state {
        case .needsYou, .unknown:
            [ask.check?.draft?.to, (ask.check?.deadline ?? ask.at).map { when($0) }].compactMap(\.self)
                .joined(separator: " · ").nilIfEmpty
        case .later: ask.later.map { "Later · \(when($0, withTime: true))" } ?? "Later"
        case .waitingOnSomeone: "Waiting for a reply"
        case .settled: ask.closed?.sent == nil ? "Done" : "Sent"
        case .outdated: ask.closed?.withdrawn?.why ?? "Out of date"
        case .underWay: nil
        }
    }

    private func when(_ date: Date, withTime: Bool = false) -> String {
        let calendar = Calendar.current
        let day =
            calendar.isDate(date, inSameDayAs: life.now())
            ? "today"
            : calendar.isDate(date, inSameDayAs: calendar.date(byAdding: .day, value: 1, to: life.now()) ?? date)
                ? "tomorrow" : date.formatted(.dateTime.weekday(.abbreviated))
        return withTime ? "\(day) \(date.clock)" : day
    }

    /// Its face: the chat's when it is a message, a person's when the answer is a person; it keeps it once settled or
    /// out of date, when the wire no longer carries the draft.
    @State private var kept: String?
    private var icon: String {
        if let check = ask.check {
            if check.draft != nil { return "bubble.left" }
            if check.options.contains(where: { $0.takes == .person }) { return "person" }
        }
        return ask.closed?.sent != nil ? "bubble.left" : kept ?? "circle.dashed"
    }

    var body: some View {
        ThreadItemRow(
            title: ask.title, state: state, icon: icon, line: line, isOpen: isOpen, ref: ask.ref,
            toggle: {
                withAnimation(Motion.standard) { isOpen.toggle() }
                life.opened = isOpen ? ask.ref : nil
            }
        ) {
            detail.transition(Motion.appears)
        }
        .sheet(item: $pickingFor) { option in
            PersonPicker { party in
                Task { await life.answer(AnswerRequest(ref: ask.ref, options: [option], person: party.ref)) }
            }
            .padding(Metrics.Spacing.l).presentationDetents([.medium, .large])
        }
        .onAppear { isOpen = life.focused == ask.ref }
        .onChange(
            of: ask.check?.draft != nil || ask.check?.options.contains { $0.takes == .person } == true, initial: true
        ) {
            if ask.check != nil, icon != "circle.dashed" { kept = icon }
        }
        .onChange(of: life.focused) { if life.focused == ask.ref { isOpen = true } }
        // Answered or out of date, it folds back to its row and its line.
        .onChange(of: ask.state) { if [.settled, .outdated].contains(ask.state) { isOpen = false } }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            if let check = ask.check, ask.isAnswerable, !isQueued {
                card(check)
            } else if let check = ask.check, isQueued {
                // His answer waits for Life: the message that will go is shown.
                if let draft = DraftBlock(check: check, isBoxed: false) { draft } else { question }
            } else if !ask.question.isEmpty {
                question
            }
            if case .failed(let failure, _) = action, let why = reason(of: failure) {
                Text(why).font(.line).foregroundStyle(Palette.muted).accessibilityIdentifier(AID.askFailure(ask.ref))
            }
            if ask.undoLine != nil { undo }
            if ask.closed?.rate?.mark == nil, ask.closed?.rate != nil, !isRated { rating }
        }
    }

    private var question: some View { Text(ask.question).font(.line).foregroundStyle(Palette.muted) }

    /// One line of why, in plain words (Life's own server text for a send that did not go is never shown).
    private func reason(of failure: ActionFailure) -> String? {
        if let by = failure.wrote?.by { return "\(by) wrote since." }
        return failure.reason.lowercased().hasPrefix("not sent") ? "It did not go. Nothing was sent." : failure.reason
    }

    /// The options of the card that are answers: a put-off ("Not now") is Later, which every ask offers.
    private func answers(of check: Check) -> [Check.Option] {
        check.options.filter { $0.icon != .later && $0.id != "not-now" }
    }

    private func card(_ check: Check) -> some View {
        let options = answers(of: check)
        let isFailed = { if case .failed = action { true } else { false } }()
        // What each answer's button says: the one that failed says "Not sent", and tapping it tries again.
        let shown = { (option: Check.Option) in isFailed && option.id == tapped ? "Not sent" : option.label }
        let byLabel = Dictionary(options.map { (shown($0), $0) }, uniquingKeysWith: { first, _ in first })
        let taking = options.contains { $0.takes == .note || $0.takes == .personOrName }
        let recommended = options.first { $0.id == check.recommended }.map(shown)
        return AskCard(
            question: ask.question, check: check, edits: check.edits ?? [], answers: options.map(shown),
            recommended: recommended,
            busy: action.isRunning ? tapped.flatMap { id in options.first { $0.id == id }.map(shown) } : nil,
            taking: taking ? $words : nil,
            disabled: Set(
                options.filter { ($0.takes == .note || $0.takes == .personOrName) && words.isEmpty }.map(shown)),
            identify: { l in byLabel[l].map { AID.askAnswer(ask.ref, $0.id) } },
            say: { l in
                if l == "Later" {
                    tapped = nil
                    Task { await life.later(ask.ref) }
                } else if let option = byLabel[l] {
                    tapped = option.id
                    if option.takes == .person {
                        pickingFor = option.id
                    } else {
                        Task {
                            await life.answer(
                                AnswerRequest(
                                    ref: ask.ref, options: [option.id], note: option.takes == .note ? words : nil,
                                    name: option.takes == .personOrName ? words : nil))
                        }
                    }
                }
            },
            edit: { label in
                _ = life.thread.ask(label, screen: MainSessionScreen(open: ask.ref, tab: "thread"), tap: true)
            }, isInItem: true)
    }

    /// "How am I doing?" under an answered ask: his mark is one answer, then the row goes.
    private var rating: some View {
        RatingRow(
            pick: { reaction in
                Task {
                    await life.answer(.rating(ask.ref, RatingMark.of(reaction)))
                    // The row goes only once Life took the mark (or holds it for when it is back); a failure stays
                    // under the ask (`askFailure`) with the row, and a tap on a mark tries again.
                    if case .succeeded = action { isRated = true } else if isQueued { isRated = true }
                }
            }, close: { isRated = true },
            identify: { AID.askRate(ask.ref, RatingMark.of($0).rawValue) })
    }

    /// His Undo: first what the other side will see, when Life says there is something to see, then the deletion.
    private var undo: some View {
        let warning = ask.undoLine.flatMap { $0.isEmpty ? nil : $0 }
        return SentLine(
            phase: action.isRunning ? .undoing : isConfirmingUndo ? .confirming(warning ?? "") : .sent(canUndo: true),
            undo: {
                if warning != nil, !isConfirmingUndo {
                    isConfirmingUndo = true
                } else {
                    isConfirmingUndo = false
                    Task { await life.undo(ask.ref) }
                }
            },
            keep: { isConfirmingUndo = false }, undoID: AID.askUndo(ask.ref))
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

extension Date {
    /// The 24-hour clock, as the design writes times ("17:00").
    var clock: String { formatted(Date.FormatStyle(locale: Locale(identifier: "en_GB")).hour().minute()) }
}
