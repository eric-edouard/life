import SwiftUI

/// A screen's short title (decision 84): its name, and at most one state word beside it, muted ("Inbox 4 waiting",
/// "Matters 7 running"). A name, never a sentence; nothing else beside it, since the bars hold the buttons.
struct ScreenTitle: View {
    let name: String
    var state: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Metrics.Spacing.s) {
            Text(name).font(.screenTitle).foregroundStyle(Palette.fg)
            if let state { Text(state).font(.small).foregroundStyle(Palette.muted) }
        }
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Metrics.gutter)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

extension View {
    /// The screen's title in the system's own top bar (`safeAreaBar`): the content starts under it and scrolls beneath,
    /// softened by iOS's soft scroll edge alone (decision 96: a blur growing toward the edge, invisible at rest, no band,
    /// tint or line; Reduce Transparency is the system's to draw). On a list screen only: a page whose first line is its name (a matter, a person, an
    /// agent) and a sheet (its `SheetHeader`) have none. A nil name keeps the bar empty, so a column whose title moves
    /// to its neighbour (the Inbox's ask beside its list) keeps its identity through a fold.
    func screenTitle(_ name: String?, state: String? = nil) -> some View {
        modifier(ScreenTitleBar(name: name, state: state))
    }
}

private struct ScreenTitleBar: ViewModifier {
    let name: String?
    let state: String?

    func body(content: Content) -> some View {
        content
            .safeAreaBar(edge: .top, spacing: 0) {
                if let name {
                    ScreenTitle(name: name, state: state)
                        .padding(.top, Metrics.Spacing.m).padding(.bottom, Metrics.Spacing.l)
                }
            }
            .scrollEdgeEffectStyle(.soft, for: .top)
    }
}
