import LifeConnector
import SwiftUI

/// What he has typed or opened on a card.
struct CardInput: Equatable {
    var isWritingOwnWords = false
    var words = ""
    var showsWhy = false
}

/// A link on the ask and what it does: "Why this reply?", or "Tell the agent…".
struct AskLink {
    let title: String
    let run: () -> Void
}

/// A card's answers inside its panel: the deadline's line, the first option filled, the others in one row when they are
/// few and short and fit, else each on a row of its own. An option that takes more than a tap asks for it: who it is
/// ("Same as…"), or his words. `link` is the ask's one link when the row under the thing has no room for it.
struct CheckActions: View {
    let check: Check
    @Binding var input: CardInput
    /// His answer is being sent or saved: its busy pill stands in for the answers.
    let isBusy: Bool
    let link: AskLink?
    /// An agent's question has "Tell the agent…" among its answers when its link is taken by "Why?".
    let hasOwnWordsAnswer: Bool
    let answer: (AnswerRequest) -> Void
    let sameAs: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    private var words: String { input.words.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: Metrics.Spacing.s) {
            if input.isWritingOwnWords {
                Button {
                    if let request = check.answer(words: words) { answer(request) }
                } label: {
                    Text(check.group == .newMatter ? "Save the goal" : "Send my answer")
                }
                .buttonStyle(.pill(.filled))
                .disabled(words.isEmpty)
                Button("Back to the options") { input.isWritingOwnWords = false }.buttonStyle(
                    .pill(.quiet, size: .compact))
            } else if isBusy {
                Button {
                } label: {
                    Text(check.draft != nil ? "Sending…" : "Saving…")
                }
                .buttonStyle(.pill(.quiet, isBusy: true)).disabled(true)
            } else {
                line
                options
            }
        }
    }

    /// The deadline in one line above the answers, with the link at its right end when the row under the thing had none.
    @ViewBuilder private var line: some View {
        let text = check.deadlineLine()
        if text != nil || link != nil {
            // Under an accessibility size the link goes under the words, not beside them.
            let layout =
                typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading)) : AnyLayout(HStackLayout(spacing: Metrics.Spacing.m))
            layout {
                if let text { Text(text).font(.small).foregroundStyle(Palette.muted) }
                if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                if let link { TextLink(link.title, action: link.run) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private struct Choice: Identifiable {
        let id: String
        let label: String
        let run: () -> Void
    }

    @ViewBuilder private var options: some View {
        if let first = check.options.first {
            Button {
                tap(first)
            } label: {
                HStack(spacing: Metrics.Spacing.s) {
                    if first.outgoing == true { Image(systemName: "arrow.up").accessibilityHidden(true) }
                    Text(first.label)
                }
            }
            .buttonStyle(.pill(.filled))
            let rest =
                check.options.dropFirst().map { option in Choice(id: option.id, label: option.label) { tap(option) } }
                + (hasOwnWordsAnswer
                    ? [Choice(id: "own-words", label: "Tell the agent…") { input.isWritingOwnWords = true }] : [])
            if !rest.isEmpty { others(rest) }
        }
    }

    /// One row of 44 when there are at most three, each of three words or fewer, and the row holds them; else rows of 48.
    @ViewBuilder private func others(_ rest: [Choice]) -> some View {
        let isShort = rest.count <= 3 && rest.allSatisfy { $0.label.split(separator: " ").count <= 3 }
        let stack = VStack(spacing: Metrics.Spacing.s) {
            ForEach(rest) { choice in Button(choice.label, action: choice.run).buttonStyle(.pill(.quiet, size: .row)) }
        }
        if isShort && !typeSize.isAccessibilitySize {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Metrics.Spacing.s) {
                    ForEach(rest) { choice in
                        Button(choice.label, action: choice.run).buttonStyle(.pill(.quiet, size: .compact))
                            .lineLimit(1)
                    }
                }
                stack
            }
        } else {
            stack
        }
    }

    /// One tap answers; an option that takes a note opens his words (a new matter's goal, ready to edit), one that names
    /// someone opens "Same as…".
    private func tap(_ option: Check.Option) {
        if let request = check.answer(option) { return answer(request) }
        switch option.takes {
        case .note?:
            input.words = check.goal ?? ""
            input.isWritingOwnWords = true
        case .person?, .personOrName?: sameAs()
        case .unknown?, nil: break
        }
    }
}
