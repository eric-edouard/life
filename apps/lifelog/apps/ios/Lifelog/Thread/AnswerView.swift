import ContextMarkdown
import LifeConnector
import SwiftUI

/// What Life says: its Markdown (headings, lists, quotes, code, tables) and, between, its own blocks. What it can't
/// show (an image, HTML) shows as its words.
struct AnswerView: View {
    let parts: [AnswerPart]
    let actions: BlockActions

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                switch part {
                case .markdown(let text): MarkdownView(text: text)
                case .block(let block): BlockView(block: block, actions: actions)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Life's stored reading of someone or a matter (its situation), drawn as Ask Life's answers are. Its blocks act on
/// nothing (`BlockActions()`); nothing shows when there is no reading.
struct SituationView: View {
    let parts: [SituationPart]

    var body: some View {
        if !parts.isEmpty {
            AnswerView(parts: AnswerPart.parts(of: SituationPart.markdown(of: parts)), actions: BlockActions())
        }
    }
}

/// What a `life:` link names that is neither a person nor an ask, a sheet (the one exception to "nothing of Life's opens a
/// screen", beside a picture or a phrase): a matter's page, else Life's own text of it.
struct LinkSheet: View {
    let ref: String
    @Environment(LifeStore.self) private var life
    @State private var read = ReadState<LifeLinkRead>()

    var body: some View {
        ScrollView {
            if ref.hasPrefix(MatterPage.prefix) {
                MatterPage(id: ref)
            } else {
                switch read.value {
                case .person(let name, let line)?: Text([name, line].compactMap { $0 }.joined(separator: "\n"))
                case .text(let text)?: MarkdownView(text: text)
                case nil: Spinner().frame(maxWidth: .infinity)
                }
            }
        }
        .padding(Metrics.Spacing.l)
        .task {
            if !ref.hasPrefix(MatterPage.prefix) { await life.fetch(ref) { read.apply($0) } }
        }
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
}

/// A matter's page: its name, his open asks on it as live rows (by their question: the matter's name is already its
/// title), and Life's reading of it; until the night writes one, its goal.
struct MatterPage: View {
    /// A matter's id starts with it (`MatterId`, `records/matter.ts`).
    static let prefix = "matter_"
    let id: String
    @Environment(LifeStore.self) private var life
    @State private var read = ReadState<Matter>()

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
            if let matter = read.value {
                Text(matter.row.name).font(.profileName)
                ItemsBlock(refs: matter.checks.map(\.ref), isOnTheirMatter: true)
                if matter.situation.isEmpty, let goal = matter.row.goal?.text {
                    Text(goal)
                } else {
                    SituationView(parts: matter.situation)
                }
            } else if case .failed = read.phase {
                NoticeBlock(title: "Life didn't open it.")
            } else {
                Spinner().frame(maxWidth: .infinity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { await life.readMatter(id) { read.apply($0) } }
    }
}
