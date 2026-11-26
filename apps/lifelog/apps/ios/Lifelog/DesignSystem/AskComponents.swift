import LifeConnector
import SwiftUI

// What Life puts to him, and what he sets: the ask card, a question's answers, a draft's quick edits, a settings
// block. Words go only on an ask's and a question's answers, a confirm's two choices and a draft's chips; every other
// control is a mark, or "Later".

/// An ask's answers: the recommended one filled and full width, the rest two to a row, "Later" first and once. An
/// answer is never cut off: a long one wraps. While one is busy, it keeps its fill and its spinner and the others dim.
struct AnswerPills: View {
    let answers: [String]
    var recommended: String?
    /// The answer that sends a draft: its words, then the send arrow.
    var sends: String?
    var hasLater = true
    /// A yes/no question: every answer in one row, the likelier one filled and on the right.
    var isOneRow = false
    var busy: String?
    /// The answers that cannot be tapped yet (one that takes his words, before he wrote them).
    var disabled: Set<String> = []
    /// The id of an answer's button, for the end-to-end tests.
    var identify: (String) -> String? = { _ in nil }
    var say: (String) -> Void = { _ in }
    @Environment(\.dynamicTypeSize) private var size

    var body: some View {
        let rest = (hasLater ? ["Later"] : []) + answers.filter { $0 != recommended && !(hasLater && $0 == "Later") }
        // At the largest sizes each answer gets the full width: a word is never broken to fit two.
        let per = size.isAccessibilitySize ? 1 : 2
        VStack(spacing: Metrics.Spacing.s) {
            if isOneRow, !size.isAccessibilitySize {
                HStack(spacing: Metrics.Spacing.s) {
                    ForEach(rest, id: \.self) { pill($0, .quiet) }
                    if let recommended, answers.contains(recommended) { pill(recommended, .filled) }
                }
            } else if let recommended, answers.contains(recommended) {
                pill(recommended, .filled)
            }
            ForEach(
                Array(stride(from: 0, to: isOneRow && !size.isAccessibilitySize ? 0 : rest.count, by: per)), id: \.self
            ) { i in
                HStack(spacing: Metrics.Spacing.s) {
                    ForEach(rest[i..<min(i + per, rest.count)], id: \.self) { pill($0, .quiet) }
                }
            }
        }
        .allowsHitTesting(busy == nil)
    }

    private func pill(_ answer: String, _ kind: PillStyle.Kind) -> some View {
        // A pill's words stay on one line, never broken across two.
        Button {
            say(answer)
        } label: {
            HStack(spacing: Metrics.Spacing.s) {
                Text(answer)
                if answer == sends { Glyph(.send, size: 14).accessibilityHidden(true) }
            }
        }
        .lineLimit(1)
        .buttonStyle(.pill(kind, size: .row, isBusy: answer == busy)).identified(identify(answer))
        .disabled(disabled.contains(answer))
        .opacity(busy == nil || answer == busy ? 1 : Metrics.Opacity.dim)
    }
}

/// A question inside Life's answer: its answers as equal pills side by side, the likelier one filled, on the right
/// (owner, 24 Nov 2026). At the largest sizes they stack, each at full width.
struct QuestionBlock: View {
    let answers: [String]
    var recommended: String?
    var say: (String) -> Void = { _ in }
    @Environment(\.dynamicTypeSize) private var size

    var body: some View {
        let order = answers.filter { $0 != recommended } + answers.filter { $0 == recommended }
        let per = size.isAccessibilitySize ? 1 : 2
        VStack(spacing: Metrics.Spacing.s) {
            ForEach(Array(stride(from: 0, to: order.count, by: per)), id: \.self) { i in
                HStack(spacing: Metrics.Spacing.s) {
                    ForEach(order[i..<min(i + per, order.count)], id: \.self) { answer in
                        Button(answer) { say(answer) }.buttonStyle(
                            .pill(answer == recommended ? .filled : .quiet, size: .row))
                    }
                }
            }
        }
    }
}

/// A draft's quick edits (the card's `edits`): up to three chips under the draft, at its trailing edge, muted. A tapped
/// edit's chip goes (`ItemRow`); the round back arrow that would undo it needs the server (the lab's #1429).
struct EditChips: View {
    let edits: [String]
    /// The chip just tapped: it shows a spinner while Life changes the draft.
    var busy: String?
    var pick: (String) -> Void = { _ in }

    var body: some View {
        // A chip is never broken: at large text sizes whole chips wrap to the next line.
        RightFlow(spacing: Metrics.Spacing.s) {
            ForEach(edits.prefix(3), id: \.self) { edit in
                QuietChip(edit, isMuted: true, isBusy: edit == busy) { pick(edit) }.fixedSize()
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// Views in lines that wrap whole, each line flush right.
private struct RightFlow: Layout {
    var spacing: CGFloat

    private func lines(_ subviews: Subviews, width: CGFloat) -> [[Int]] {
        var lines: [[Int]] = [[]]
        var x: CGFloat = 0
        for (i, view) in subviews.enumerated() {
            let w = view.sizeThatFits(.unspecified).width
            if x > 0, x + w > width { lines.append([]); x = 0 }
            lines[lines.count - 1].append(i)
            x += w + spacing
        }
        return lines
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let rows = lines(subviews, width: width)
        var heights: [CGFloat] = []
        var widest: CGFloat = 0
        for row in rows {
            let sizes = row.map { subviews[$0].sizeThatFits(.unspecified) }
            heights.append(sizes.map(\.height).max() ?? 0)
            let total: CGFloat = sizes.map(\.width).reduce(0, +)
            widest = max(widest, total + spacing * CGFloat(max(row.count - 1, 0)))
        }
        let gaps: CGFloat = spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(
            width: proposal.width ?? widest, height: heights.reduce(0, +) + gaps)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in lines(subviews, width: bounds.width) {
            let sizes = row.map { subviews[$0].sizeThatFits(.unspecified) }
            var x = bounds.maxX - sizes.map(\.width).reduce(0, +) - spacing * CGFloat(max(row.count - 1, 0))
            for (i, size) in zip(row, sizes) {
                subviews[i].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += (sizes.map(\.height).max() ?? 0) + spacing
        }
    }
}

/// An ask: a header (its question, why in one line), the draft as its chat (`DraftBlock`) with its quick edits, and
/// the answers, on a `wash` with no edge. On its own it opens with the item's header, a disc, the question and its line,
/// as the prototype's ask page does. A spending stop carries one small line of amounts under the why. Inside a thread
/// item (`isInItem`) it has no wash and no side padding of its own, and no header: the item's is the page's.
struct AskCard: View {
    let question: String
    var why: String?
    var icon = Glyph.Mark.bubble
    var check: Check?
    var edits: [String] = []
    /// The quick edit tapped last, while Life changes the draft.
    var editing: String?
    var amounts: String?
    let answers: [String]
    var recommended: String?
    var busy: String?
    /// The words an answer takes (a note, a name): a field over the answers while it is set.
    var taking: Binding<String>?
    var disabled: Set<String> = []
    var identify: (String) -> String? = { _ in nil }
    var say: (String) -> Void = { _ in }
    /// Sends the words of `taking` by the answer that takes them: Return in the field, or its Save.
    var submit: (() -> Void)?
    /// A tap on one of the draft's quick edits.
    var edit: (String) -> Void = { _ in }
    var isInItem = false
    /// A card of Life's own by kind (`AskLook`): its words to read along, its people, its needs.
    var look: AskLook?
    var pick: (Party) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            // Inside an item the row's own header is the title: its question is not said again.
            if !isInItem {
                HStack(spacing: Metrics.Spacing.m) {
                    Glyph(icon, size: 22).foregroundStyle(Palette.muted)
                        .frame(width: Metrics.askDisc, height: Metrics.askDisc).background(Palette.tint, in: .circle)
                        .accessibilityHidden(true)
                    Text(question).font(.header).multilineTextAlignment(.leading)
                }
            }
            // Why it asks, Markdown (a guess's quoted words and where they were said): the prototype's `.why`.
            if let why { MarkdownView(text: why).font(.line).foregroundStyle(Palette.muted) }
            if let amounts { Text(amounts).font(.meta).foregroundStyle(Palette.faint) }
            if let check, let draft = DraftBlock(check: check, isBoxed: false) {
                draft
                if !edits.isEmpty { EditChips(edits: edits, busy: editing, pick: edit) }
            }
            if let look { look.body(pick: pick) }
            if let taking {
                HStack(spacing: Metrics.Spacing.s) {
                    Field(prompt: "Your words", text: taking).onSubmit { submit?() }.submitLabel(.done)
                    if let submit {
                        Button("Save", action: submit).buttonStyle(.pill(.filled, size: .compact))
                            .disabled(taking.wrappedValue.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            AnswerPills(
                answers: answers, recommended: recommended,
                sends: check?.options.first { $0.outgoing == true }.map { look?.label($0) ?? $0.label },
                isOneRow: look?.isYesNo == true, busy: busy,
                disabled: disabled, identify: identify, say: say
            )
        }
        .padding(.vertical, isInItem ? 0 : Metrics.Spacing.l).padding(.horizontal, isInItem ? 0 : Metrics.Spacing.l)
        .frame(maxWidth: .infinity, alignment: .leading).washed(!isInItem)
    }
}

/// Life's settings, no page: a block in its answer. Its rows act in place (a switch, a value pill), a green tick for a
/// second after one went through.
struct SettingsBlock<Rows: View>: View {
    @ViewBuilder var rows: Rows

    var body: some View {
        VStack(spacing: 0) { rows }.padding(.horizontal, Metrics.Spacing.l).card()
    }
}

struct SettingSwitchRow: View {
    let title: String
    let isOn: Bool
    var isTicked = false
    var set: (Bool) -> Void = { _ in }

    var body: some View {
        HStack(spacing: Metrics.Spacing.m) {
            Text(title).font(.rowTitle)
            Spacer(minLength: 0)
            if isTicked {
                Glyph(.tick, size: 13).foregroundStyle(Palette.ok).accessibilityLabel("Changed")
            }
            RowSwitch(title: title, isOn: isOn, set: set)
        }
        .frame(minHeight: Metrics.tapTarget + Metrics.Spacing.s)
    }
}

/// A value pill row: the title and its choices as pills, the chosen one filled.
struct SettingValueRow: View {
    let title: String
    let choices: [String]
    let selection: String
    var isTicked = false
    var set: (String) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            HStack {
                Text(title).font(.rowTitle)
                Spacer(minLength: 0)
                if isTicked { Glyph(.tick, size: 13).foregroundStyle(Palette.ok) }
            }
            HStack(spacing: Metrics.Spacing.s) {
                ForEach(choices, id: \.self) { choice in
                    Button(choice) { set(choice) }
                        .buttonStyle(.pill(choice == selection ? .filled : .quiet, size: .compact))
                }
            }
        }
        .padding(.vertical, Metrics.Spacing.m)
    }
}

/// A change Life offers as a question, with its two answers.
struct OfferBlock: View {
    let question: String
    var answers = ["Yes", "No"]
    var say: (String) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            Text(question).font(.body15)
            QuestionBlock(answers: answers, recommended: answers.first, say: say)
        }
    }
}
