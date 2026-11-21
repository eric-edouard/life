import LifeConnector
import SwiftUI

/// Every open ask of one kind on one card, when Life pre-ticks 2 or more of them (`InboxOrder.folded`): the question,
/// the rows in their groups (`Check.bulkGroups`), each ticked with the answer Life reads, and "Answer N", which holds
/// one answer per ticked row as one, for one Undo (`HeldAnswers`). A row's body opens its own card; "Go one by one"
/// unfolds the kind. Rows whose answer Life refused come back alone, ticked, with Life's reason above the answers.
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
            if let opened {
                NavigationStack {
                    CardPage(ref: opened, source: rows, notes: $openedNotes) { self.opened = nil }
                        .toolbar { CloseItem { self.opened = nil } }
                }
            }
        }
    }

    /// The rows Life refused, alone, when there are any; else every row.
    private var shown: [Check] { failed.isEmpty ? rows : failed }

    private var failed: [Check] {
        rows.filter { if case .failed = life.state(of: .answer(ref: $0.ref)) { true } else { false } }
    }

    private var ticked: [Check] {
        shown.filter { $0.preTickedOption != nil && !notes.unticked.contains($0.ref) }
    }

    private func row(_ check: Check) -> some View {
        let isTicked = ticked.contains { $0.ref == check.ref }
        return TickRow(
            isTicked: isTicked,
            tick: {
                if isTicked {
                    notes.unticked.insert(check.ref)
                } else if check.preTickedOption != nil {
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

    /// "Yes, done", "Don't name", "Yes, <who>"; nil when Life ticks nothing.
    private func answerWords(of check: Check) -> String? {
        guard let option = check.preTickedOption else { return nil }
        let who = check.likelyPeople.first { $0.ref == check.subject }?.name
        return option.id == "is-them" ? who.map { "\(option.label), \($0)" } ?? option.label : option.label
    }

    private var answers: some View {
        VStack(spacing: Metrics.Spacing.s) {
            if let page {
                PagerDots(current: page.current, total: page.total).frame(maxWidth: .infinity, alignment: .trailing)
            }
            if let first = failed.first, case .failed(let failure, _) = life.state(of: .answer(ref: first.ref)) {
                // Life's own reason when Life answered; the fixed line only when the connection failed.
                Text("\(failed.count) not answered: \(failure.isSameTap ? "not sent to your Mac." : failure.reason)")
                    .font(.small).foregroundStyle(Palette.flag).frame(maxWidth: .infinity, alignment: .leading)
                    .appears()
            }
            Button(ticked.isEmpty ? "Answer" : "Answer \(ticked.count)") {
                answer(ticked.compactMap { row in row.preTickedOption.flatMap { row.answer($0) } })
            }
            .buttonStyle(.pill(.filled)).disabled(ticked.isEmpty)
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
