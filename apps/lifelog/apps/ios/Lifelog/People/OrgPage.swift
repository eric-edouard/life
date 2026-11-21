import LifeConnector
import SwiftUI

/// An organization's page, from the same read as a person's (`now`): its name and what it is, how to reach it, the
/// people he knows there (now first, then "Before", quieter), its open matters, its last exchange, and its domains.
struct OrgPage: View {
    let now: PersonNow
    /// Its accounts, every one once the `reach` part's pages are read (`PersonNow.withEveryAccount`).
    let reach: ReachTiles

    var body: some View {
        let (present, before) = now.membersNowThenBefore
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                    VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                        Text(now.row.party.name).font(.screenName).foregroundStyle(Palette.fg)
                            .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                        if let line = now.row.party.line {
                            Label(line, systemImage: "building.2").font(.body15).foregroundStyle(Palette.muted)
                        }
                    }
                    reach
                }
                if !now.members.isEmpty || now.membersLeftOut > 0 {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(present) { member in MemberRow(member: member) }
                        if !before.isEmpty {
                            Text("Before").font(.small).foregroundStyle(Palette.muted)
                                .padding(.top, Metrics.Spacing.m).padding(.bottom, Metrics.Spacing.xs)
                            ForEach(before) { member in MemberRow(member: member, isDim: true) }
                        }
                        LeftOut(count: now.membersLeftOut, one: "person", many: "people", isOnly: now.members.isEmpty)
                    }
                    .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.xs)
                    .card()
                }
                OpenMatters(label: "Matters", now: now)
                Latest(subject: now.row.party.ref, label: "Last exchange", count: 1)
                Domains(domains: now.domains, leftOut: now.domainsLeftOut)
            }
            .padding(.horizontal, Metrics.gutter).padding(.top, Metrics.Spacing.s).padding(.bottom, Metrics.Spacing.xl)
            .readingWidth()
        }
    }
}

/// Someone he knows at the organization: their row with the role (and when they left) as its line; a tap opens them.
private struct MemberRow: View {
    let member: PersonNow.Member
    var isDim = false

    var body: some View {
        NavigationLink(value: AppRouter.PersonRoute.party(member.party.ref)) {
            PartyRow(party: member.party, line: member.line, isDim: isDim) {
                Image(systemName: "chevron.right").font(.small).foregroundStyle(Palette.muted)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, Metrics.Spacing.s)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

/// Its web and mail domains, each a row; a tap opens the site.
private struct Domains: View {
    let domains: [String]
    let leftOut: Int

    var body: some View {
        if !domains.isEmpty || leftOut > 0 {
            VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                ForEach(domains, id: \.self) { domain in
                    if let url = URL(string: "https://\(domain)") {
                        Link(destination: url) {
                            HStack(spacing: Metrics.Spacing.m) {
                                Image(systemName: "globe").foregroundStyle(Palette.muted).accessibilityHidden(true)
                                Text(domain).font(.body15).foregroundStyle(Palette.fg)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Image(systemName: "arrow.up.right").font(.small).foregroundStyle(Palette.muted)
                                    .accessibilityHidden(true)
                            }
                        }
                        .accessibilityLabel("Open \(domain)")
                    }
                }
                LeftOut(count: leftOut, one: "domain", many: "domains", isOnly: domains.isEmpty)
            }
            .padding(Metrics.Spacing.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
        }
    }
}

/// What Life had no room for in this read, said so a shortened list never reads as whole: "3 more people", "1 more person".
private struct LeftOut: View {
    let count: Int
    /// What it counts, one and many: "person", "people".
    let one: String
    let many: String
    /// Nothing of the list fit: the line stands for all of it ("3 people").
    let isOnly: Bool

    var body: some View {
        if count > 0 {
            let what = count == 1 ? one : many
            Text(isOnly ? "\(count) \(what)" : "\(count) more \(what)").font(.small).foregroundStyle(Palette.muted)
                .padding(.vertical, Metrics.Spacing.s)
        }
    }
}
