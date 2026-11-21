import LifeConnector
import SwiftUI

/// Every open ask of one kind on one card, when Life pre-ticks 2 or more of them (`InboxOrder.folded`): the question,
/// the rows in their groups (`Check.bulkGroups`), each ticked with the answer Life reads, and "Answer N", which holds
/// one answer per ticked row as one, for one Undo (`HeldAnswers`). A row's body opens its own card, whose answer goes
/// back to the row (ticked, in its words) and leaves with the others; "Go one by one" unfolds the kind. Rows its
/// "Answer N" sent that Life refused come back alone, with Life's reason above the answers; one that may have gone is
/// not ticked again.
struct BulkCard: View {
    let kind: CheckGroup
    /// The kind's open asks, in the inbox's order.
    let rows: [Check]
    /// The rows he unticked and the kinds he goes through one by one: the screen's, so a fold or a read keeps them.
    @Binding var notes: CardNotes
    var page: (current: Int, total: Int)?
    /// On from this card (the guesses' "Done").
    var finish: () -> Void = {}
    /// His answers, one per ticked row.
    let answer: ([AnswerRequest]) -> Void

    @Environment(LifeStore.self) private var life
    /// The row whose own card is open over the list.
    @State private var opened: String?
    @State private var openedNotes = CardNotes()
    @State private var openedCurrent: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                Text(kind.bulkQuestion).font(.cardQuestion).foregroundStyle(Palette.fg)
                    .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                if kind == .guessedPerson { guessRows }
                ForEach(kind == .guessedPerson ? [] : Check.bulkGroups(shown), id: \.first?.ref) { group in
                    if let heading = kind.bulkHeading(group[0].preTicked) {
                        HStack {
                            Text(heading).accessibilityAddTraits(.isHeader)
                            Spacer(minLength: 0)
                            Text("\(group.count)")
                        }
                        .font(.small).foregroundStyle(group[0].preTicked == nil ? Palette.flag : Palette.muted)
                    }
                    VStack(spacing: 0) { ForEach(group) { row($0) } }
                        .padding(.horizontal, Metrics.Spacing.s)
                        .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
                }
            }
            .padding(.horizontal, Metrics.Spacing.s).padding(.vertical, Metrics.Spacing.m).readingWidth()
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollEdgeEffectStyle(.soft, for: .vertical)
        .safeAreaBar(edge: .bottom, spacing: 0) {
            (kind == .guessedPerson ? AnyView(guessAnswers) : AnyView(answers)).padding(.horizontal, Metrics.Spacing.s)
                .readingWidth()
        }
        .onChange(of: rows, initial: true) { _, rows in
            guard kind == .guessedPerson else { return }
            notes.working.insert(kind)
            notes.guesses += rows.filter { row in !notes.guesses.contains { $0.ref == row.ref } }
        }
        .motion(Motion.standard, value: shown.map(\.ref))
        .sheet(
            isPresented: Binding(get: { opened != nil }, set: { if !$0 { opened = nil } }),
            onDismiss: { openedNotes = CardNotes() }
        ) {
            if let check = rows.first(where: { $0.ref == opened }) {
                NavigationStack {
                    CardView(
                        check: check, checks: [check], current: $openedCurrent, notes: $openedNotes,
                        context: ContextRegion(check: check, runtimeName: life.runtimeName(of: check)),
                        takes: { taken in
                            if kind == .guessedPerson {
                                send(taken.request, as: taken.heldWords, on: check)
                            } else {
                                notes.chosen[check.ref] = taken
                                notes.unticked.remove(check.ref)
                            }
                            opened = nil
                        }
                    ) { _, _ in opened = nil }
                    .background(Palette.bg)
                    .toolbar { CloseItem { opened = nil } }
                }
            }
        }
    }

    /// The rows Life refused, alone, when there are any; else every row.
    private var shown: [Check] { failed.isEmpty ? rows : failed }

    /// Rows this card's "Answer N" sent that did not go, each with why.
    private var failed: [Check] { rows.filter { failure(of: $0) != nil } }

    private func failure(of check: Check) -> ActionFailure? {
        guard notes.sentInBulk.contains(check.ref),
            case .failed(let failure, _) = life.state(of: .answer(ref: check.ref))
        else { return nil }
        return failure
    }

    /// Its last answer, from any card, may have reached Life: never sent again from here.
    private func mayHaveGone(_ check: Check) -> Bool {
        if case .failed(let failure, _) = life.state(of: .answer(ref: check.ref)) {
            failure.mayHaveHappened
        } else {
            false
        }
    }

    /// The answer each ticked row gives: his on its own card, else Life's pre-ticked one; never one that may have gone.
    private var ticked: [(check: Check, request: AnswerRequest)] {
        shown.compactMap { check in
            guard !notes.unticked.contains(check.ref), !mayHaveGone(check) else { return nil }
            let request = notes.chosen[check.ref]?.request ?? check.preTickedOption.flatMap { check.answer($0) }
            return request.map { (check, $0) }
        }
    }

    private func row(_ check: Check) -> some View {
        let isTicked = ticked.contains { $0.check.ref == check.ref }
        return TickRow(
            isTicked: isTicked,
            tick: {
                if isTicked {
                    notes.unticked.insert(check.ref)
                } else if check.preTickedOption != nil || notes.chosen[check.ref] != nil {
                    notes.unticked.remove(check.ref)
                } else {
                    // Life reads no answer for it: his own card says who.
                    opened = check.ref
                }
            },
            open: { opened = check.ref }
        ) {
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    if kind == .voice, let clip = check.clips.first {
                        VoiceLine(clip: clip)
                    } else {
                        Text(check.said?.text ?? check.question).font(.leadBold).foregroundStyle(Palette.fg)
                            .lineLimit(1)
                    }
                    detail(of: check)
                }
                // A voice's sign is its Play; any other row opens its own card.
                if kind != .voice {
                    Spacer(minLength: Metrics.Spacing.s)
                    Image(systemName: "chevron.right").font(.smallStrong)
                        .foregroundStyle(Palette.muted)
                }
            }
        }
    }

    /// The row's muted line: when and how long for a voice, what came since for any other, then the answer it gives. An
    /// answer that is a person says it first, then their disc and name ("Yes, <disc> <who> · Fri 13 Nov"); the length
    /// leaves to make room.
    @ViewBuilder private func detail(of check: Check) -> some View {
        let clip = check.clips.first
        let about =
            kind == .voice
            ? [clip?.at.map { SaidWords.day($0) }, clip?.lengthText]
            : [check.since?.text ?? check.matter?.name]
        let answer = answerOf(check)
        if let person = answer.person {
            HStack(spacing: Metrics.Spacing.xs) {
                if let lead = answer.lead { Text(lead) }
                PartyDisc(name: person, size: .chip)
                Text(person).font(.smallStrong).foregroundStyle(Palette.fg)
                Text(about.prefix(1).compactMap(\.self).joined(separator: " · ")).lineLimit(1)
            }
            .font(.small).foregroundStyle(Palette.muted).lineLimit(1)
        } else {
            Text((about + [answer.words]).compactMap(\.self).joined(separator: " · "))
                .font(.small).foregroundStyle(Palette.muted).lineLimit(1)
        }
    }

    /// His answer on the row's own card, else "Yes, done", "Don't name", "Yes, <who>" ("Is this <who>? Yes" when Life
    /// names no candidate); nothing when nothing is ticked. `person` is a name to show with its disc.
    private func answerOf(_ check: Check) -> (lead: String?, person: String?, words: String?) {
        let chosen = notes.chosen[check.ref]
        if let chosen {
            if chosen.request.options != ["is-them"] {
                let who = check.likelyPeople.first { $0.ref == chosen.request.person }?.name
                return (nil, who, who == nil && kind != .ending ? chosen.heldWords : nil)
            }
        }
        guard let option = chosen == nil ? check.preTickedOption : check.options.first(where: { $0.id == "is-them" })
        else { return (nil, nil, nil) }
        // An ending's "Yes, done" is its group's heading, never said on each row.
        guard option.id == "is-them" else { return (nil, nil, kind == .ending ? nil : option.label) }
        let who = check.likelyPeople.first { $0.ref == check.subject }?.name
        return who.map { ("\(option.label),", $0, nil) } ?? (nil, nil, "\(check.question) \(option.label)")
    }

    // MARK: Guesses: Yes or No on each row, each answer its own

    /// The rows he has met on this card: the same person ask first, then the guesses, answered ones kept.
    private var guessRows: some View {
        let all = notes.guesses + rows.filter { row in !notes.guesses.contains { $0.ref == row.ref } }
        let same = all.filter { $0.group == .samePerson }
        return VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            ForEach(same) { check in
                SamePersonTile(
                    check: check, state: guessState(check), failure: guessFailure(check),
                    answer: { send(check, yes: $0) }, undo: { undo(check) }, open: { opened = check.ref })
            }
            let rest = all.filter { $0.group != .samePerson }
            if !rest.isEmpty {
                Text("Is this them?").font(.small).foregroundStyle(Palette.muted).padding(.leading, Metrics.Spacing.s)
                VStack(spacing: 0) {
                    ForEach(rest) { check in
                        GuessRow(
                            check: check, state: guessState(check), failure: guessFailure(check),
                            answer: { send(check, yes: $0) }, undo: { undo(check) }, open: { opened = check.ref })
                    }
                }
                .padding(.horizontal, Metrics.Spacing.s)
                .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
            }
        }
    }

    private func guessState(_ check: Check) -> GuessState {
        let yes = notes.guessed[check.ref] == "Yes"
        if life.held[check.ref] != nil { return .held(yes: yes) }
        return !rows.contains { $0.ref == check.ref } && notes.guessed[check.ref] != nil ? .answered(yes: yes) : .rest
    }

    /// Life's reason when its last answer on the row did not land (a row back at rest only).
    private func guessFailure(_ check: Check) -> String? {
        guard case .failed(let failure, _) = life.state(of: .answer(ref: check.ref)) else { return nil }
        return failure.isSameTap && !failure.mayHaveHappened ? "your Mac did not answer" : failure.reason
    }

    /// Yes is the option Life pre-ticked, No the one that drops the guess (`not-this-person`).
    private func send(_ check: Check, yes: Bool) {
        let option = yes ? check.preTickedOption : check.options.first { $0.id == "not-this-person" }
        guard let request = option.flatMap({ check.answer($0) }) else {
            opened = check.ref
            return
        }
        send(request, as: yes ? "Yes" : "No", on: check)
    }

    private func send(_ request: AnswerRequest, as words: String, on check: Check) {
        guard !life.saysOutOfReach() else { return }
        life.forget(.answer(ref: check.ref))
        notes.guessed[check.ref] = words
        life.hold(request, as: words)
    }

    private func undo(_ check: Check) {
        life.undo(check.ref)
        notes.guessed[check.ref] = nil
    }

    private var guessAnswers: some View {
        VStack(spacing: Metrics.Spacing.s) {
            HStack {
                Text("Each answer saves on its own").font(.small).foregroundStyle(Palette.muted)
                Spacer(minLength: 0)
                if let page { PagerDots(current: page.current, total: page.total) }
            }
            Button {
                notes.working.remove(kind)
                (notes.guesses, notes.guessed) = ([], [:])
                finish()
            } label: {
                Label("Done", systemImage: "checkmark")
            }
            .buttonStyle(.pill(.filled))
            Button("Go one by one") { notes.unfolded.insert(kind) }.buttonStyle(.pill(.quiet, size: .compact))
        }
        .padding(.bottom, Metrics.Spacing.s)
    }

    private var answers: some View {
        VStack(spacing: Metrics.Spacing.s) {
            if let page {
                PagerDots(current: page.current, total: page.total).frame(maxWidth: .infinity, alignment: .trailing)
            }
            if let failure = failed.first.flatMap(failure(of:)) {
                // Life's own reason when Life answered (or why it may have gone); the fixed line when nothing reached it.
                let why = failure.isSameTap && !failure.mayHaveHappened ? "not sent to your Mac." : failure.reason
                Text("\(failed.count) not answered: \(why)")
                    .font(.small).foregroundStyle(Palette.flag).frame(maxWidth: .infinity, alignment: .leading)
                    .appears()
            }
            if kind == .ending, !ticked.isEmpty {
                Text("Life read an ending for each ticked one").font(.small).foregroundStyle(Palette.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button(ticked.isEmpty ? "Answer" : "Answer \(ticked.count)") {
                answer(ticked.map(\.request))
            }
            .buttonStyle(.pill(.filled)).disabled(ticked.isEmpty).offWhileOutOfReach()
            .contentTransition(.numericText()).motion(Motion.standard, value: ticked.count)
            Button("Go one by one") { withAnimation(Motion.standard) { _ = notes.unfolded.insert(kind) } }
                .buttonStyle(.pill(.quiet, size: .compact))
        }
        .padding(.bottom, Metrics.Spacing.s)
    }
}

/// A voice row's first words, lit as they play, with its Play at the right (`SpokenWords`, one clip at a time).
private struct VoiceLine: View {
    let clip: Check.Clip

    var body: some View {
        if let audio = clip.audio, let job = UUID(uuidString: audio.jobId) {
            SpokenWords(
                text: clip.text, words: clip.words, job: job, start: audio.start, end: audio.end, style: .line
            )
            .font(.lead)
        } else {
            Text("“\(clip.text)”").font(.lead).foregroundStyle(Palette.fg).lineLimit(1)
        }
    }
}
