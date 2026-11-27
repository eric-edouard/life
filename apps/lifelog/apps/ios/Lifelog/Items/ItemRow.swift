import LifeConnector
import SwiftUI

/// One ask of his thread as the design system's item: Life gives the state (`ThreadAsk.State`), the phone adds only
/// "queued" (his answer waits for Life to be back). Unfolded, an ask he can answer is an `AskCard`; one he cannot is
/// its question; a send he may undo is a `SentLine`.
struct ItemRow: View {
    let ask: ThreadAsk
    /// On its matter's page: the row's title is its question (the page's title is the matter's name).
    var isOnTheirMatter = false
    /// Arrives unfolded: a single ask in an answer.
    var startsOpen = false
    /// Life brought it to the bottom of the thread on its own: led by why it asks, with no fold button.
    var isBrought = false
    @Environment(LifeStore.self) private var life
    @State private var isOpen = false
    @State private var words = ""
    @State private var isConfirmingUndo = false
    /// The answer he tapped last: the one that shows its spinner while Life works, and "Not sent" if it failed.
    @State private var tapped: String?
    /// His "How am I doing?": the mark he gave (the row says "Thanks" and dims), or the cross (the row goes).
    @State private var rated: Reaction?
    @State private var isRatingClosed = false
    /// The quick edits he tapped: each goes once tapped, and the tapped one spins while Life changes the draft.
    @State private var usedEdits: Set<String> = []
    @State private var editing: String?

    private var key: LifeStore.ActionKey { .answer(ref: ask.ref) }
    private var action: ActionState<ActionProof> { life.state(of: key) }
    private var isQueued: Bool { life.isQueued(ask.ref) }

    /// The card as it was open: its needs (the event, the run) are gone from the wire once it settles.
    @State private var keptCheck: Check?

    /// What his last answer made happen, drawn on the row in place (the lab's picks): the event in his calendar, the
    /// run under way, Life looking for his payment. Only from the proof of the tap he just made.
    private var outcome: (state: ItemState, line: String)? {
        let option = keptCheck?.options.first { $0.id == tapped }
        if action.isRunning, option?.looks == true { return (.looking, "Looking in your bank…") }
        guard case .succeeded(.answered(let result), _) = action else { return nil }
        let need = { (kind: Check.Need.Kind) in keptCheck?.needs?.first { $0.kind == kind }?.line }
        if result.changed?.added?.error == nil, result.changed?.added != nil {
            return (.settled, ["In your calendar", need(.event)].compactMap(\.self).joined(separator: " · "))
        }
        if result.changed?.ran?.error == nil, result.changed?.ran != nil {
            let words = need(.apify).map { "Running · \($0)" } ?? "Running"
            return (.underWay(progress: 0.1, estimate: words), words)
        }
        switch result.doneSeen?.state {
        case .looking: return (.looking, result.doneSeen?.line ?? "Looking…")
        case .seen: return (.settled, result.doneSeen?.line ?? "Seen")
        case .notFound: return (.waitingOnSomeone, result.doneSeen?.line ?? "Not seen yet. I look again")
        default: return nil
        }
    }

    private var state: ItemState {
        if let outcome { return outcome.state }
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
        if let outcome { return outcome.line }
        if isQueued { return "Goes when you're back" }
        return switch ask.state {
        case .needsYou, .unknown:
            // Who, then when it is due: a Life check's `at` is only when the thread read it, never a day to show.
            [look?.line, ask.check?.deadline.map { when($0) }].compactMap(\.self).joined(separator: " · ").nilIfEmpty
        case .later: ask.later.map { "Later · \(when($0, withTime: true))" } ?? "Later"
        case .waitingOnSomeone: waitingLine
        case .settled: ask.closed?.sent == nil ? "Done" : recipient.map { "Sent to \($0)" } ?? "Sent"
        case .outdated: ask.closed?.withdrawn?.why ?? "Out of date"
        case .underWay: nil
        }
    }

    /// "Waiting on Paul's quote · Thu": who it waits on and since when, else the plain line.
    private var waitingLine: String {
        let on = look?.face.flatMap { face in if case .party(let party) = face { party.name } else { nil } }
        let day = ask.at.map { when($0) }
        return [on.map { "Waiting on \($0)" } ?? "Waiting for a reply", day].compactMap(\.self).joined(separator: " · ")
    }

    private func when(_ date: Date, withTime: Bool = false) -> String {
        let day = DeadlineWords.day(date, now: life.now())
        return withTime ? "\(day) \(date.clock)" : day
    }

    /// Its face: the chat's when it is a message, a person's when the answer is a person; it keeps it once settled or
    /// out of date, when the wire no longer carries the draft.
    @State private var kept: Glyph.Mark?
    @State private var keptTo: String?
    /// Who a draft is for: its card's, as kept, or what a settled card's answered option says.
    private var recipient: String? { ask.check?.draft?.to ?? keptTo ?? ask.closed?.sentTo }
    /// Its face (the prototype's "their face or mark"): who it is for, their picture or initial; else its matter's icon;
    /// else a mark by kind (`icon`).
    private var look: AskLook? { ask.check.map(AskLook.init) }
    private var face: ItemFace? {
        look?.face ?? recipient.flatMap { $0.first }.map { .initial(String($0)) }
            ?? (matterMark == nil ? matterRef?.symbol.map { .symbol($0) } : nil)
    }
    private var matterRef: Check.MatterRef? { ask.check?.matter ?? ask.check?.onMatters?.first }
    /// The prototype's own marks for the matters whose icon it draws itself: a place's pin, a bank's columns.
    private var matterMark: Glyph.Mark? {
        switch matterRef?.icon {
        case "bank": .bank
        case "place": .pin
        default: nil
        }
    }
    private var icon: Glyph.Mark {
        if let check = ask.check {
            if check.draft != nil { return .bubble }
            if check.group == .voice { return .wave }
            if check.group == .fix { return .life }
            if check.payCode != nil || check.needs?.contains(where: { $0.kind == .amount }) == true { return .card }
            if check.options.contains(where: { $0.takes == .person || $0.takes == .personOrName }) { return .person }
            if check.needs?.contains(where: { $0.kind == .event }) == true { return .calendar }
            if check.needs?.contains(where: { $0.kind == .apify }) == true { return .search }
            if check.needs?.contains(where: { $0.kind == .link }) == true { return .pin }
            if let matterMark { return matterMark }
        }
        return ask.closed?.sent != nil ? .bubble : kept ?? .doc
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            if isBrought || ask.state == .outdated, let lead { Text(lead).font(.body15).foregroundStyle(Palette.fg) }
            row
            if isConfirmingUndo || (action.isRunning && ask.undoLine != nil) { undo.appears(Motion.fade) }
            if hasRating { rating.appears() }
        }
        .motion(Motion.standard, value: hasRating)
    }

    /// Why Life brought it, as the line that leads it in: "Jade asked about Saturday:".
    private var lead: String? {
        (ask.check ?? keptCheck)?.context.map { words in
            let line = words.trimmingCharacters(in: .whitespacesAndNewlines)
            return (line.hasSuffix(".") ? String(line.dropLast()) : line) + ":"
        }
    }

    /// "How am I doing?" shows under one ask a day at most: the first to show it keeps the day until its mark.
    private var hasRating: Bool {
        guard !isRatingClosed else { return false }
        if rated != nil { return true }
        guard ask.closed?.rate != nil, ask.closed?.rate?.mark == nil else { return false }
        let today = life.now().formatted(.iso8601.year().month().day())
        let key = "ratingDay", refKey = "ratingRef"
        let defaults = UserDefaults.standard
        if defaults.string(forKey: key) == today { return defaults.string(forKey: refKey) == ask.ref }
        return true
    }

    private var row: some View {
        ThreadItemRow(
            title: isOnTheirMatter && !ask.question.isEmpty
                ? ask.question : look?.title(fallback: ask.title) ?? ask.title,
            state: state, icon: icon,
            face: face,
            line: line, isOpen: isOpen, ref: ask.ref,
            pill: pill, canFold: !isBrought,
            toggle: {
                Motion.animate { isOpen.toggle() }
                if isOpen { life.opened = ask.ref } else if life.opened == ask.ref { life.opened = nil }
            }
        ) {
            detail.transition(Motion.appears)
        }
        .onAppear { isOpen = startsOpen || life.focused == ask.ref }
        // A newer ask Life brings folds the one before it.
        .onChange(of: startsOpen) { if !startsOpen { Motion.animate { isOpen = false } } }
        .onChange(of: hasRating, initial: true) {
            guard hasRating else { return }
            let defaults = UserDefaults.standard
            defaults.set(life.now().formatted(.iso8601.year().month().day()), forKey: "ratingDay")
            defaults.set(ask.ref, forKey: "ratingRef")
        }
        .onChange(
            of: ask.check?.draft != nil || ask.check?.options.contains { $0.takes == .person } == true, initial: true
        ) {
            if let check = ask.check { keptCheck = check }
            if ask.check != nil, icon != .doc { kept = icon }
            if let to = ask.check?.draft?.to { keptTo = to }
        }
        .id(ask.ref)
        .onChange(of: life.focused) { if life.focused == ask.ref { Motion.animate { isOpen = true } } }
        // Answered or out of date, it folds back to its row and its line.
        .onChange(of: ask.state) {
            if [.settled, .outdated].contains(ask.state) { Motion.animate { isOpen = false } }
        }
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
                Text(why).font(.line).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(AID.askFailure(ask.ref))
            }
        }
        .motion(Motion.standard, value: action.isRunning)
    }

    /// The one tap on the folded row: a task's Later, or a send's Undo (the prototype's line, "Sent to Lena · Undo").
    private var pill: RowPill? {
        if state == .needsYou, ask.check?.isTask == true, ask.isAnswerable {
            return .init(title: "Later", id: nil) { Task { await life.later(ask.ref) } }
        }
        guard ask.undoLine != nil, !isConfirmingUndo, !action.isRunning else { return nil }
        return .init(title: "Undo", id: AID.askUndo(ask.ref)) { undoTapped() }
    }

    private var question: some View { Text(ask.question).font(.line).foregroundStyle(Palette.muted) }

    /// One line of why, in plain words (Life's own server text for a send that did not go is never shown).
    private func reason(of failure: ActionFailure) -> String? {
        if let by = failure.wrote?.by { return "\(by) wrote since." }
        return failure.reason.lowercased().hasPrefix("not sent") ? "It did not go. Nothing was sent." : failure.reason
    }

    /// The options of the card that are answers: a put-off ("Not now") is Later, which every ask offers; one that takes
    /// a person is answered by the people's cards (`AskBody`).
    private func answers(of check: Check) -> [Check.Option] {
        check.options.filter {
            $0.icon != .later && $0.id != "not-now" && $0.takes != .person && AskLook(check: check).shows($0)
        }
    }

    private func card(_ check: Check) -> some View {
        let options = answers(of: check)
        let isFailed = { if case .failed = action { true } else { false } }()
        // What each answer's button says: the one that failed says "Not sent", and tapping it tries again.
        let look = AskLook(check: check)
        let shown = { (option: Check.Option) in isFailed && option.id == tapped ? "Not sent" : look.label(option) }
        let byLabel = Dictionary(options.map { (shown($0), $0) }, uniquingKeysWith: { first, _ in first })
        let wordsOption = options.first { $0.takes == .note || $0.takes == .personOrName }
        // A Contacts card asks "Is this them?": its Yes is Life's guess, one tap, beside "Someone else".
        let guess = check.group == .contactsCard ? check.likelyPeople.first : nil
        // The one wide answer (the prototype's `.prim`): the agent's pick, else the first of two or more, Life's guess.
        let pick = check.recommended ?? (options.count > 1 ? options.first?.id : nil)
        let recommended = guess != nil ? "Yes" : options.first { $0.id == pick }.map(shown)
        let say = { (l: String) in
            if l == "Later" {
                tapped = nil
                Task { await life.later(ask.ref) }
            } else if l == "Yes", let guess, let request = check.answer(naming: .person(guess.ref)) {
                tapped = request.options.first
                Task { await life.answer(request) }
            } else if let option = byLabel[l] {
                tapped = option.id
                Task {
                    await life.answer(
                        AnswerRequest(
                            ref: ask.ref, options: [option.id], note: option.takes == .note ? words : nil,
                            name: option.takes == .personOrName ? words : nil))
                }
            }
        }
        // His typed words (a name, a note) go by the answer that takes them: on Return, or its Save.
        let submit = wordsOption.map { option in { if !words.isEmpty { say(shown(option)) } } }
        return AskCard(
            question: ask.question, why: why(check), check: check,
            edits: (check.edits ?? []).filter { !usedEdits.contains($0) || ($0 == editing && life.thread.isWorking) },
            editing: life.thread.isWorking ? editing : nil, answers: (guess != nil ? ["Yes"] : []) + options.map(shown),
            recommended: recommended,
            busy: action.isRunning ? tapped.flatMap { id in options.first { $0.id == id }.map(shown) } : nil,
            taking: wordsOption != nil ? $words : nil,
            disabled: Set(
                options.filter { ($0.takes == .note || $0.takes == .personOrName) && words.isEmpty }.map(shown)),
            identify: { l in byLabel[l].map { AID.askAnswer(ask.ref, $0.id) } },
            say: say, submit: submit,
            edit: { label in
                editing = label
                usedEdits.insert(label)
                _ = life.thread.ask(label, screen: MainSessionScreen(open: ask.ref, tab: "thread"), tap: true)
            }, isInItem: true, look: look,
            pick: { party in
                guard let request = check.answer(naming: .person(party.ref)) else { return }
                tapped = request.options.first
                Task { await life.answer(request) }
            })
    }

    /// Why it asks (Markdown), after the step itself on his own move, whose title is its matter.
    private func why(_ check: Check) -> String? {
        [check.group == .yourMove ? check.question.nilIfEmpty : nil, isBrought ? nil : check.context].compactMap(\.self)
            .joined(separator: "\n\n").nilIfEmpty
    }

    /// "How am I doing?" under an answered ask: his mark is one answer, then the row goes.
    private var rating: some View {
        RatingRow(
            picked: rated,
            pick: { reaction in
                Task {
                    await life.answer(.rating(ask.ref, RatingMark.of(reaction)))
                    // The row goes only once Life took the mark (or holds it for when it is back); a failure stays
                    // under the ask (`askFailure`) with the row, and a tap on a mark tries again.
                    if case .succeeded = action { rated = reaction } else if isQueued { rated = reaction }
                }
            }, close: { isRatingClosed = true },
            identify: { AID.askRate(ask.ref, RatingMark.of($0).rawValue) })
    }

    /// His Undo: first what the other side will see, when Life says there is something to see, then the deletion.
    private func undoTapped() {
        if ask.undoLine?.isEmpty == false, !isConfirmingUndo {
            isConfirmingUndo = true
        } else {
            isConfirmingUndo = false
            Task { await life.undo(ask.ref) }
        }
    }

    /// Under the row once he tapped Undo: what the other side will see and Delete for both, then Undoing….
    private var undo: some View {
        SentLine(
            phase: action.isRunning ? .undoing : .confirming(ask.undoLine ?? ""), undo: undoTapped,
            keep: { isConfirmingUndo = false }, undoID: AID.askUndo(ask.ref))
    }
}
