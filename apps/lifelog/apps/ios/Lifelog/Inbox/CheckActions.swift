import LifeConnector
import SwiftUI

/// What he has typed or opened on a card.
struct CardInput: Equatable {
    var isWritingOwnWords = false
    var words = ""
    var showsWhy = false
}

/// A card's answers: its options as Life labels them, "Something else" where an agent reads his words, the link to the
/// asker's app and what happens on silence. An option that takes more than a tap asks for it: who it is ("Same as…"),
/// or his words. Apart from the card so a wide screen can put them at the bottom of the card's region or, when the
/// regions are stacked, of the screen.
struct CheckActions: View {
    let check: Check
    let runtimeName: RuntimeName?
    @Binding var input: CardInput
    let answer: (AnswerRequest) -> Void
    let sameAs: () -> Void

    @Environment(\.openURL) private var openURL

    private var words: String { input.words.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: 8) {
            if input.isWritingOwnWords {
                Button {
                    if let request = check.answer(words: words) { answer(request) }
                } label: {
                    Text(check.group == .newMatter ? "Save the goal" : "Send my answer")
                }
                .buttonStyle(.pill(.filled))
                .disabled(words.isEmpty)
                Button("Back to the options") { input.isWritingOwnWords = false }.buttonStyle(.pill(.quiet))
            } else {
                if let line = deadlineLine {
                    Text(line).font(.small).foregroundStyle(Palette.faint).multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
                options
                HStack {
                    if check.takesOwnWords {
                        TextLink("Something else") { input.isWritingOwnWords = true }
                    }
                    Spacer(minLength: 12)
                    if let link = check.links.first.flatMap(URL.init(string:)) {
                        TextLink("Open in \(runtimeName?.name ?? "its app")", isOutward: true) { openURL(link) }
                    }
                }
            }
        }
    }

    @ViewBuilder private var options: some View {
        if let first = check.options.first {
            Button {
                tap(first)
            } label: {
                HStack(spacing: 10) {
                    if first.outgoing == true { Image(systemName: "arrow.up").accessibilityHidden(true) }
                    Text(first.label)
                }
            }
            .buttonStyle(.pill(.filled))
            let rest = Array(check.options.dropFirst())
            if !rest.isEmpty {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible())], spacing: 8) {
                    ForEach(rest, id: \.id) { option in
                        Button(option.label) { tap(option) }.buttonStyle(.pill(.quiet))
                    }
                }
            }
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

    /// What happens when his deadline passes, above the answers: the only line a card puts near them.
    private var deadlineLine: String? {
        guard check.group == .decision || check.group == .unknown, let deadline = check.deadline else { return nil }
        let when = deadline.formatted(.dateTime.weekday(.wide).hour().minute())
        if check.draft != nil { return "No answer by \(when): nothing is sent." }
        let chosen = check.options.first { $0.id == check.onSilence }?.label
        return "No answer by \(when): " + (chosen.map { "“\($0)”." } ?? "nothing happens.")
    }
}
