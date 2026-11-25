import LifeConnector
import SwiftUI

/// The sheet an option that `takes` a person opens: his directory's people, searched by name. A tap hands the person
/// back and closes it.
struct PersonPicker: View {
    let pick: (Party) -> Void
    @Environment(LifeStore.self) private var life
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var groups: [PeopleList.Group] { life.people.value?.sections(kind: .people, query: query) ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            Field(prompt: "Search people", text: $query, surface: .sheet, icon: "magnifyingglass")
            if life.people.value == nil {
                if case .failed = life.people.phase {
                    NoticeBlock(title: "Life didn't open your people")
                } else {
                    Spinner().frame(maxWidth: .infinity)
                }
            }
            // The list rows bring their own gutter: the sheet's is taken back for them.
            VStack(alignment: .leading, spacing: 0) {
                ForEach(groups) { group in
                    ListLabel(group.label)
                    ForEach(Array(group.rows.enumerated()), id: \.element.id) { index, row in
                        Button {
                            pick(row.party)
                            dismiss()
                        } label: {
                            HStack(spacing: Metrics.Spacing.m) {
                                Face(party: row.party)
                                VStack(alignment: .leading, spacing: Metrics.Spacing.xs / 2) {
                                    Text(row.party.name).font(.rowTitle)
                                    if let line = row.standing() {
                                        Text(line).font(.line).foregroundStyle(Palette.muted)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                        }
                        .buttonStyle(.groupedRow(at: index, of: group.rows.count))
                    }
                }
            }.padding(.horizontal, -Metrics.gutter)
        }
        .sheetScroll { SheetHeader(title: "Who?", close: { dismiss() }) }
        .background(Palette.sheet).presentationBackground(Palette.sheet)
        .task { await life.refreshPeople() }
    }
}
