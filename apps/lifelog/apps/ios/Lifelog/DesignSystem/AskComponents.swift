import SwiftUI

// What Life puts to him, and what he sets: the ask card, a question's answers, a draft's quick edits, a settings
// block. Words go only on an ask's and a question's answers, a confirm's two choices and a draft's chips; every other
// control is a mark, or "Later".

/// An ask's answers: the recommended one filled, the rest quiet, then "Later".
struct AnswerPills: View {
    let answers: [String]
    var recommended: String?
    var hasLater = true
    var say: (String) -> Void = { _ in }

    var body: some View {
        HStack(spacing: Metrics.Spacing.s) {
            ForEach(answers, id: \.self) { answer in
                Button(answer) { say(answer) }.buttonStyle(
                    .pill(answer == recommended ? .filled : .quiet, size: .compact))
            }
            if hasLater { Button("Later") { say("Later") }.buttonStyle(.pill(.quiet, size: .compact)) }
        }
    }
}

/// A question inside Life's answer: its answers stacked, the recommended one filled.
struct QuestionBlock: View {
    let answers: [String]
    var recommended: String?
    var say: (String) -> Void = { _ in }

    var body: some View {
        VStack(spacing: Metrics.Spacing.s) {
            ForEach(answers, id: \.self) { answer in
                Button(answer) { say(answer) }.buttonStyle(
                    .pill(answer == recommended ? .filled : .quiet, size: .compact))
            }
        }
    }
}

/// A draft's quick edits (the card's `edits`): up to three chips under the draft.
struct EditChips: View {
    let edits: [String]
    var pick: (String) -> Void = { _ in }

    var body: some View {
        HStack(spacing: Metrics.Spacing.s) {
            ForEach(edits.prefix(3), id: \.self) { edit in QuietChip(edit) { pick(edit) } }
        }
    }
}

/// An ask unfolded: its question, why in one line, the draft as a `paper` quote with its quick edits, and the answers.
/// A spending stop carries one small line of amounts under the why, never in the title.
struct AskCard: View {
    let question: String
    var why: String?
    var draft: String?
    var edits: [String] = []
    var amounts: String?
    let answers: [String]
    var recommended: String?
    var isBusy = false

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            Text(question).font(.header)
            if let why { Text(why).font(.line).foregroundStyle(Palette.muted) }
            if let amounts { Text(amounts).font(.meta).foregroundStyle(Palette.faint) }
            if let draft {
                Text(draft).font(.body15).padding(Metrics.Spacing.m).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.paper, in: .rect(cornerRadius: Metrics.Radius.control))
                if !edits.isEmpty { EditChips(edits: edits) }
            }
            AnswerPills(answers: answers, recommended: recommended)
                .opacity(isBusy ? 0.5 : 1).allowsHitTesting(!isBusy)
        }
        .padding(Metrics.Spacing.l).frame(maxWidth: .infinity, alignment: .leading).card()
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
