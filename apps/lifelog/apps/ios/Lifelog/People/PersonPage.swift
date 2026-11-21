import LifeConnector
import SwiftUI

/// A person's or an organization's page, from the one read of them (`now`): who they are to him and how close.
struct PersonPage: View {
    let ref: String
    /// Settings beside the Pendant: on a regular width the list's bar has neither, so the page carries both.
    var hasSettings = false

    @Environment(LifeStore.self) private var life

    var body: some View {
        let state = life.person[ref] ?? ReadState()
        ReadScreen(
            shown: state.shown(), retry: { await life.refreshPerson(ref) },
            loading: { PagePlaceholder() },
            empty: { EmptyView() },
            content: { now in page(now) }
        )
        .background(Palette.bg)
        .shellBar("", hasSettings: hasSettings)
        .task(id: life.parties.generation.current) { await life.refreshPerson(ref) }
    }

    private func page(_ now: PersonNow) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                Who(row: now.row)
            }
            .padding(.horizontal, Metrics.gutter).padding(.top, Metrics.Spacing.s).padding(.bottom, Metrics.Spacing.xl)
            .readingWidth()
        }
    }
}

/// Who: their picture (72) beside the name and who they are to him, then how close and their last exchange.
private struct Who: View {
    let row: PersonRow

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            HStack(spacing: Metrics.Spacing.l) {
                PartyDisc(row.party, size: .page)
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                    Text(row.party.name).font(.screenName).foregroundStyle(Palette.fg)
                        .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                    if let line = row.party.line { Text(line).font(.body15).foregroundStyle(Palette.muted) }
                }
            }
            if let standing = row.standing() { Text(standing).font(.body15).foregroundStyle(Palette.muted) }
        }
    }
}
