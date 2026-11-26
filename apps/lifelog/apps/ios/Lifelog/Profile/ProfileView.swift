import LifeConnector
import SwiftUI

/// Someone's profile: their face and what they are to him; his open asks about them and their open matters, drawn live;
/// Life's reading of them (their situation, as the night wrote it); their details and how to reach them. One level deep:
/// nothing here opens another profile. What Life's read lacks is left out.
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
                    ItemsBlock(refs: read.asks)
                    matters(read.openShown(isAll: false, all: nil))
                    SituationView(parts: read.situation)
                    details(read.details)
                    reach(read.reach)
                } else if isFailed {
                    NoticeBlock(title: "Life didn't open it.")
                } else {
                    Spinner().frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, Metrics.gutter).padding(.vertical, Metrics.Spacing.l)
            .motion(Motion.standard, value: read != nil)
        }
        .background(Palette.bg).task { await life.refreshPerson(ref) }
    }

    /// Their running matters, each opening its page.
    @ViewBuilder private func matters(_ open: [MatterRow]) -> some View {
        RowGroup {
            ForEach(Array(open.enumerated()), id: \.element.id) { index, matter in
                Button {
                    if let url = URL.lifeOpen(matter.id) { openURL(url) }
                } label: {
                    Row(title: matter.name, detail: matter.needsYou == true ? "Needs you" : nil, isInList: true)
                }
                .buttonStyle(.groupedRow(at: index, of: open.count))
            }
        }
    }

    /// Their birthday, home, work, family and handles, as his directory and Contacts give them.
    @ViewBuilder private func details(_ details: [PersonNow.Detail]) -> some View {
        if !details.isEmpty {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                ForEach(Array(details.enumerated()), id: \.offset) { _, detail in
                    Text(detail.text).font(.line).foregroundStyle(Palette.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// How to reach them: a round button per account, its app's mark, no words (VoiceOver says which app and account).
    @ViewBuilder private func reach(_ reach: [PersonNow.Reach]) -> some View {
        let accounts = reach.flatMap { page in page.accounts.map { (page, $0) } }
        if !accounts.isEmpty {
            HStack(spacing: Metrics.Spacing.m) {
                ForEach(Array(accounts.enumerated()), id: \.offset) { _, entry in
                    if let url = URL(string: entry.1.open.url) {
                        Button {
                            openURL(url)
                        } label: {
                            NetworkMark(network: entry.0.network, size: Metrics.Spacing.xl)
                                .frame(width: Metrics.disc, height: Metrics.disc).background(Palette.tint, in: .circle)
                                .frame(minWidth: Metrics.tapTarget, minHeight: Metrics.tapTarget)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(entry.0.label), \(entry.1.title ?? entry.1.handle)")
                    }
                }
            }
            .frame(maxWidth: .infinity)
        }
    }
}
