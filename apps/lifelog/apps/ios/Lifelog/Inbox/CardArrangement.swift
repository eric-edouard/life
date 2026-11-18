import LifeConnector
import SwiftUI

/// A card region and the context it rests on: one region on a compact width, two peer regions on a regular one (the iPhone
/// Duo open), which the system puts on the fold, side by side when wide and stacked when upright. The answers sit at the
/// bottom of the card's region, or of the screen when the regions are stacked, where a thumb reaches. It branches on the
/// size class alone, and holds nothing a fold could lose: what he typed and the card shown live in the screen above.
struct CardArrangement<Region: View, Bar: View>: View {
    let check: Check
    @ViewBuilder let region: Region
    @ViewBuilder let bar: Bar

    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var axis: Axis?

    var body: some View {
        if sizeClass == .regular, #available(iOS 27.1, *) {
            ArrangementView {
                region.safeAreaInset(edge: .bottom, spacing: 0) { if axis != .vertical { row.background(Palette.bg) } }
                    .modifier(ReportAxis(axis: $axis))
            } secondary: {
                ContextRegion(check: check)
            }
            .arrangementViewStyle(.split)
            .safeAreaBar(edge: .bottom) { if axis == .vertical { row } }
        } else {
            region.safeAreaInset(edge: .bottom, spacing: 0) { row.background(Palette.bg) }
        }
    }

    private var row: some View { bar.padding(.horizontal, 20).padding(.bottom, 8).readingWidth() }
}

/// Tells the screen which way the split runs: only the region's own environment knows.
@available(iOS 27.1, *)
private struct ReportAxis: ViewModifier {
    @Binding var axis: Axis?
    @Environment(\.splitArrangementAxis) private var splitAxis

    func body(content: Content) -> some View {
        content.onChange(of: splitAxis, initial: true) { axis = splitAxis }
    }
}

/// What a card rests on: why Life asked, then its matter (goal, next step, newest steps) and the way into it.
private struct ContextRegion: View {
    let check: Check

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let why = check.context, !why.isEmpty {
                    Caps("Why")
                    Text(why).font(.body15).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }
                if let id = check.matter?.id, let matter = life.matter[id]?.value { matterBlock(matter) }
            }
            .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .readingWidth()
        }
        .scrollBounceBehavior(.basedOnSize)
        .task(id: check.matter?.id) { if let id = check.matter?.id { await life.refreshMatter(id) } }
    }

    private func matterBlock(_ matter: Matter) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Caps("Matter")
            Text(matter.row.name).font(.quote).foregroundStyle(Palette.fg)
            line("Goal", matter.row.goal?.text)
            line("Next step", matter.row.nextStep?.text)
            ForEach(matter.steps.suffix(3).reversed()) { step in
                VStack(alignment: .leading, spacing: 2) {
                    Text(
                        [step.at.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)), step.with]
                            .compactMap(\.self).joined(separator: " · ")
                    )
                    .font(.body15).foregroundStyle(Palette.muted)
                    Text(step.text).font(.leadBold).foregroundStyle(Palette.fg)
                }
                .accessibilityElement(children: .combine)
            }
            Button("Open the matter") { router.open(matter: matter.row.id) }.buttonStyle(.pill(.quiet, height: 48))
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
