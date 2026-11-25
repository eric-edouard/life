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
            VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                if let read {
                    VStack(spacing: Metrics.Spacing.s) {
                        Face(party: read.row.party, size: 96)
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
                    ForEach(read.reach) { reach in
                        ForEach(reach.accounts) { account in
                            if let url = URL(string: account.open.url) {
                                Button {
                                    openURL(url)
                                } label: {
                                    Text("\(reach.label) · \(account.title ?? account.handle)").frame(
                                        maxWidth: .infinity, alignment: .leading
                                    )
                                    .frame(minHeight: Metrics.tapTarget)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                } else if isFailed {
                    Text("Life didn't open it.").foregroundStyle(Palette.muted)
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
}
