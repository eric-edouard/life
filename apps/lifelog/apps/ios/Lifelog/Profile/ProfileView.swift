import LifeConnector
import SwiftUI

/// Someone's profile: their face, what they are to him, what is open with them, and how to reach them. One level deep:
/// nothing here opens another profile. Sections come from Life's read; a section with nothing is left out.
struct ProfileView: View {
    let ref: String
    @Environment(LifeStore.self) private var life
    @Environment(\.openURL) private var openURL

    private var read: PersonNow? { life.person[ref]?.value }

    private var isFailed: Bool {
        if case .failed? = life.person[ref]?.phase { true } else { false }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                if let read {
                    VStack(spacing: Metrics.Spacing.s) {
                        Face(party: read.row.party, size: Metrics.profileFace)
                        Text(read.row.party.name).font(.profileName).multilineTextAlignment(.center)
                        if let line = read.row.party.line {
                            Text(line).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                        }
                    }
                    .frame(maxWidth: .infinity).padding(.top, Metrics.Spacing.xl)
                    section("Open", read.open.map(\.name))
                    section("Details", read.details.map(\.text))
                    section("Now", read.situation.map(\.text))
                    section("Writes", read.communicationStyle.map(\.text))
                    reach(read.reach)
                } else if isFailed {
                    NoticeBlock(title: "Life didn't open it.")
                } else {
                    Spinner().frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, Metrics.gutter).padding(.vertical, Metrics.Spacing.l)
        }
        .background(Palette.bg).task { await life.refreshPerson(ref) }
    }

    @ViewBuilder private func section(_ title: String, _ lines: [String]) -> some View {
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
                Text(title).font(.heading).foregroundStyle(Palette.muted).accessibilityAddTraits(.isHeader)
                ForEach(lines, id: \.self) { Text($0).lineSpacing(Metrics.Spacing.xs) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// How to reach them, one row per account, each opening its app.
    @ViewBuilder private func reach(_ reach: [PersonNow.Reach]) -> some View {
        let accounts = reach.flatMap { page in page.accounts.map { (page.label, $0) } }
        if !accounts.isEmpty {
            RowGroup(label: "Reach", surface: .page) {
                ForEach(Array(accounts.enumerated()), id: \.offset) { _, entry in
                    if let url = URL(string: entry.1.open.url) {
                        Button {
                            openURL(url)
                        } label: {
                            Row(title: "\(entry.0) · \(entry.1.title ?? entry.1.handle)") { RowValue() }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}
