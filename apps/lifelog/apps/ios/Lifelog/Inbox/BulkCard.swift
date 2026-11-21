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
                ForEach(Check.bulkGroups(shown), id: \.first?.ref) { group in
                    if let heading = kind.bulkHeading(group[0].preTicked) {
                        Text(heading).font(.small)
                            .foregroundStyle(group[0].preTicked == nil ? Palette.flag : Palette.muted)
                            .accessibilityAddTraits(.isHeader)
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
        .safeAreaBar(edge: .bottom, spacing: 0) { answers.padding(.horizontal, Metrics.Spacing.s).readingWidth() }
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
                            notes.chosen[check.ref] = taken
                            notes.unticked.remove(check.ref)
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
            VStack(alignment: .leading, spacing: 2) {
                if kind == .voice, let clip = check.clips.first {
                    VoiceLine(clip: clip)
                } else {
                    Text(check.said?.text ?? check.question).font(.leadBold).foregroundStyle(Palette.fg).lineLimit(1)
                }
                Text(detail(of: check)).font(.small).foregroundStyle(Palette.muted).lineLimit(1)
            }
        }
    }

    /// The row's muted line: when and how long for a voice, what came since for any other, then the answer it gives.
    private func detail(of check: Check) -> String {
        let clip = check.clips.first
        let about =
            kind == .voice
            ? [clip?.at.map { SaidWords.day($0) }, clip?.lengthText]
            : [check.since?.text ?? check.matter?.name]
        return (about + [answerWords(of: check)]).compactMap(\.self).joined(separator: " · ")
    }

    /// His answer on the row's own card, else "Yes, done", "Don't name", "Yes, <who>" ("Is this <who>? Yes" when Life
    /// names no candidate); nil when nothing is ticked.
    private func answerWords(of check: Check) -> String? {
        let chosen = notes.chosen[check.ref]
        if let chosen, chosen.request.options != ["is-them"] { return chosen.heldWords }
        guard let option = chosen == nil ? check.preTickedOption : check.options.first(where: { $0.id == "is-them" })
        else { return nil }
        guard option.id == "is-them" else { return option.label }
        let who = check.likelyPeople.first { $0.ref == check.subject }?.name
        return who.map { "\(option.label), \($0)" } ?? "\(check.question) \(option.label)"
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
            Button(ticked.isEmpty ? "Answer" : "Answer \(ticked.count)") {
                answer(ticked.map(\.request))
            }
            .buttonStyle(.pill(.filled)).disabled(ticked.isEmpty || life.whyOutOfReach != nil)
            .contentTransition(.numericText()).motion(Motion.standard, value: ticked.count)
            Button("Go one by one") { notes.unfolded.insert(kind) }.buttonStyle(.pill(.quiet, size: .compact))
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
                text: clip.text, words: clip.words, job: job, start: audio.start, end: audio.end, style: .inline
            )
            .font(.lead)
        } else {
            Text("“\(clip.text)”").font(.lead).foregroundStyle(Palette.fg).lineLimit(1)
        }
    }
}

extension CheckGroup {
    /// The bulk card's question.
    var bulkQuestion: String {
        switch self {
        case .ending: "Are these done?"
        case .voice: "Who are these voices?"
        default: "Answer these?"
        }
    }

    /// A group's heading on the bulk card, by the answer Life pre-ticks on it (nil: none); nil draws none.
    func bulkHeading(_ preTicked: String?) -> String? {
        switch (self, preTicked) {
        case (_, nil): "Needs you"
        case (.voice, "not-relevant"): "Heard once"
        case (.voice, "is-them"): "Probably them"
        default: nil
        }
    }
}
