import LifeConnector
import SwiftUI

// What Life puts to him, and what he sets: the ask card, a question's answers, a draft's quick edits, a settings
// block. Words go only on an ask's and a question's answers, a confirm's two choices and a draft's chips; every other
// control is a mark, or "Later".

/// An ask's answers: the recommended one filled and full width, the rest two to a row, "Later" last. An answer is
/// never cut off: a long one wraps. While one is busy, it keeps its fill and its spinner and the others dim.
struct AnswerPills: View {
    let answers: [String]
    var recommended: String?
    var hasLater = true
    var busy: String?
    /// The answers that cannot be tapped yet (one that takes his words, before he wrote them).
    var disabled: Set<String> = []
    /// The id of an answer's button, for the end-to-end tests.
    var identify: (String) -> String? = { _ in nil }
    var say: (String) -> Void = { _ in }
    @Environment(\.dynamicTypeSize) private var size

    var body: some View {
        let rest = answers.filter { $0 != recommended } + (hasLater ? ["Later"] : [])
        // At the largest sizes each answer gets the full width: a word is never broken to fit two.
        let per = size.isAccessibilitySize ? 1 : 2
        VStack(spacing: Metrics.Spacing.s) {
            if let recommended, answers.contains(recommended) { pill(recommended, .filled) }
            ForEach(Array(stride(from: 0, to: rest.count, by: per)), id: \.self) { i in
                HStack(spacing: Metrics.Spacing.s) {
                    ForEach(rest[i..<min(i + per, rest.count)], id: \.self) { pill($0, .quiet) }
                }
            }
        }
        .allowsHitTesting(busy == nil)
    }

    private func pill(_ answer: String, _ kind: PillStyle.Kind) -> some View {
        Button(answer) { say(answer) }
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

/// A draft's quick edits (the card's `edits`): up to three chips under the draft, at its trailing edge, muted.
struct EditChips: View {
    let edits: [String]
    var pick: (String) -> Void = { _ in }

    var body: some View {
        HStack(spacing: Metrics.Spacing.s) {
            Spacer(minLength: 0)
            ForEach(edits.prefix(3), id: \.self) { edit in QuietChip(edit, isMuted: true) { pick(edit) } }
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
    var icon = "bubble.left"
    var check: Check?
    var edits: [String] = []
    var amounts: String?
    let answers: [String]
    var recommended: String?
    var busy: String?
    /// The words an answer takes (a note, a name): a field over the answers while it is set.
    var taking: Binding<String>?
    var disabled: Set<String> = []
    var identify: (String) -> String? = { _ in nil }
    var say: (String) -> Void = { _ in }
    var isInItem = false

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            if isInItem {
                Text(question).font(.header)
            } else {
                HStack(spacing: Metrics.Spacing.m) {
                    Image(systemName: icon).font(.header).foregroundStyle(Palette.muted)
                        .frame(width: Metrics.askDisc, height: Metrics.askDisc).background(Palette.tint, in: .circle)
                        .accessibilityHidden(true)
                    Text(question).font(.header).multilineTextAlignment(.leading)
                }
            }
            if let why { Text(why).font(.line).foregroundStyle(Palette.muted) }
            if let amounts { Text(amounts).font(.meta).foregroundStyle(Palette.faint) }
            if let check, let draft = DraftBlock(check: check, isBoxed: false) {
                draft
                if !edits.isEmpty { EditChips(edits: edits) }
            }
            if let taking { Field(prompt: "Your words", text: taking) }
            AnswerPills(
                answers: answers, recommended: recommended, busy: busy, disabled: disabled, identify: identify, say: say
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
                Image(systemName: "checkmark").font(.lineStrong).foregroundStyle(Palette.ok).accessibilityLabel(
                    "Changed")
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
                if isTicked { Image(systemName: "checkmark").font(.lineStrong).foregroundStyle(Palette.ok) }
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
            AnswerPills(answers: answers, recommended: answers.first, hasLater: false, say: say)
        }
    }
}
