import LifeConnector
import SwiftUI

/// A card region and the context it rests on: one region on a compact width, two peer regions on a regular one (the iPhone
/// Duo open), which the system puts on the fold, side by side when wide and stacked when upright. The card carries its
/// own answers; the bar holds only what follows an answer (its result's buttons), at the bottom of the card's region, or
/// of the screen when the regions are stacked, where a thumb reaches. It alone decides
/// whether the context shows beside the card (`isContextBeside`), by the size class alone. From iOS 27.1 it is one
/// arrangement at every width, so a fold keeps the card's scroll, focus and a playing clip; what he typed and the card
/// shown live in the screen above.
struct CardArrangement<Region: View, Bar: View>: View {
    /// The region the card rests on, beside or below it; none when the card is the whole pane (the Inbox: its why stays
    /// inside the card, its matter behind the pill).
    let context: ContextRegion?
    /// What follows an answer; nil while the card is still open.
    let bar: Bar?
    @ViewBuilder let region: Region

    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        if #available(iOS 27.1, *) {
            let isBeside = sizeClass == .regular && context != nil
            let row = bar.map(rowOf)
            GeometryReader { arrangement in
                ArrangementView {
                    region.modifier(AnswersRow(row: row, bounds: arrangement.size, isLower: false))
                        .environment(\.isContextBeside, isBeside)
                } secondary: {
                    if isBeside, let context {
                        context
                            .modifier(AnswersRow(row: row, bounds: arrangement.size, isLower: true))
                    } else {
                        Color.clear
                    }
                }
                .arrangementViewStyle(.split.axes(isBeside ? Axis.Set([.horizontal, .vertical]) : Axis.Set()))
            }
        } else {
            // iOS 27.0 has no arrangement: the card alone at every width, its context behind the card's "Why" row.
            region.safeAreaBar(edge: .bottom, spacing: 0) { if let bar { rowOf(bar) } }
        }
    }

    private func rowOf(_ bar: Bar) -> some View { bar.padding(.horizontal, 20).padding(.bottom, 8).readingWidth() }
}

extension EnvironmentValues {
    /// The card's context shows in a region of its own beside or below the card, so the card leaves out its "Why" row.
    @Entry var isContextBeside = false
    /// The card stands in its matter's thread (navigation v3): its matter pill goes, the thread is the matter.
    @Entry var isInThread = false
}

/// The answers at the bottom of a region: the card's, unless the regions are stacked, then the lower one's, the bottom of
/// the screen. Read from where the split put the region, at each layout: `splitArrangementAxis` reads nil in both
/// regions, wide and upright (iOS 27.1 simulator), so it cannot say.
private struct AnswersRow<Row: View>: ViewModifier {
    let row: Row?
    /// The whole arrangement's size.
    let bounds: CGSize
    let isLower: Bool

    func body(content: Content) -> some View {
        GeometryReader { region in
            // Stacked: the region spans the arrangement's width, not its height.
            let isStacked = region.size.width > bounds.width - 1 && region.size.height < bounds.height - 1
            // The system's bar, so what scrolls under it softens at its edge (decision 96).
            content.safeAreaBar(edge: .bottom, spacing: 0) { if let row, isStacked == isLower { row } }
        }
    }
}

/// What a card rests on: its context, the same Markdown as the context sheet's, in place; then its matter (goal, next
/// step, newest steps) and the way into it. A `life:` link opens that thing's page in a sheet.
struct ContextRegion: View {
    let check: Check
    let runtimeName: RuntimeName?

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @Environment(\.openURL) private var openURL
    @State private var opened: LifeLinkTarget?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let context = check.context, check.contextLinkTitle != nil {
                    ContextView(markdown: context, lifeLinks: check.lifeLinks ?? []) { opened = $0 }
                }
                if let id = check.matter?.id, let matter = life.matter[id]?.value { matterBlock(matter) }
                if let link = check.session.flatMap(URL.init(string:)) {
                    TextLink("Open in \(runtimeName?.name ?? "its app")", to: .outside) { openURL(link) }
                }
            }
            .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .readingWidth()
        }
        .scrollBounceBehavior(.basedOnSize)
        .sheet(item: $opened) { target in
            NavigationStack { LifeLinkPage(target: target, isPushed: false) { opened = nil } }
                .presentationDetents([.medium, .large])
        }
        .task(id: check.matter?.id) { if let id = check.matter?.id { await life.refreshMatter(id) } }
    }

    private func matterBlock(_ matter: Matter) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(matter.row.name).font(.quote).foregroundStyle(Palette.fg)
            line("Goal", matter.row.goal?.text)
            line("Next step", matter.row.nextStep?.text)
            ForEach(matter.steps.suffix(3).reversed()) { step in
                VStack(alignment: .leading, spacing: 2) {
                    Text(step.whenAndWith).font(.body15).foregroundStyle(Palette.muted)
                    Text(step.text).font(.leadBold).foregroundStyle(Palette.fg)
                }
                .accessibilityElement(children: .combine)
            }
            Button("Open the matter") { router.open(matter: matter.row.id) }.buttonStyle(.pill(.quiet, size: .compact))
        }
    }

    @ViewBuilder private func line(_ label: String, _ text: String?) -> some View {
        if let text, !text.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Caps(label)
                Text(text).font(.lead).foregroundStyle(Palette.fg).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
