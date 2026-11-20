import LifeConnector
import SwiftUI
import UIKit

/// A person's or an organization's page, from the one read of them (`now`). A person's in the order he looks: who they
/// are to him and how close, how to reach them, what is open with them, lately, their details, what Life knows (each a
/// page of its own), and their latest exchanges; an organization's is `OrgPage`. Only what exists shows: nothing says
/// empty.
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
            content: { now in
                if now.row.party.kind == .organization {
                    OrgPage(
                        now: now, reach: now.withEveryAccount(now.moreReach.map { life.reachPages(from: $0) }).reach)
                } else {
                    page(now)
                }
            }
        )
        .background(Palette.bg)
        .shellBar("", hasSettings: hasSettings)
        .task(id: life.parties.generation.current) { await life.refreshPerson(ref) }
        .task(id: state.value?.moreReach) {
            if let first = state.value?.moreReach { await life.refreshReach(from: first) }
        }
    }

    private func page(_ now: PersonNow) -> some View {
        // Every account, once `now` sent the `reach` part's ref for those it had no room for.
        let (reach, details) = now.withEveryAccount(now.moreReach.map { life.reachPages(from: $0) })
        return ScrollView {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                    Who(row: now.row)
                    if !reach.isEmpty { ReachTiles(reach: reach) }
                }
                OpenMatters(label: "Open with \(now.firstName)", now: now)
                Lately(lines: now.situation.map(\.text))
                Details(details: details)
                Knows(now: now, ref: ref)
                Latest(subject: ref)
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

/// Reach: five equal tiles at most, each an app's mark over its name, one tap to their chat or a call. An app with
/// several accounts carries a chevron and opens the system menu of them (their name there over the handle, newest
/// first); past five, the fifth is More.
struct ReachTiles: View {
    let reach: [PersonNow.Reach]
    private static let across = 5

    var body: some View {
        let shown = reach.count > Self.across ? Array(reach.prefix(Self.across - 1)) : reach
        HStack(spacing: Metrics.Spacing.s) {
            ForEach(shown) { app in tile(app) }
            if reach.count > Self.across {
                Menu {
                    ForEach(reach.dropFirst(Self.across - 1)) { app in
                        Section(app.label) { accounts(app) }
                    }
                } label: {
                    face(
                        Image(systemName: "ellipsis").font(.body15).foregroundStyle(Palette.fg), "More", several: false)
                }
            }
            ForEach(0..<max(0, Self.across - reach.count), id: \.self) { _ in Color.clear.frame(maxWidth: .infinity) }
        }
    }

    @ViewBuilder private func tile(_ app: PersonNow.Reach) -> some View {
        let mark = NetworkMark(network: app.network == "call" ? "phone" : app.network, size: 20)
        if app.accounts.count == 1, let url = app.accounts.first.flatMap({ URL(string: $0.open.url) }) {
            Link(destination: url) { face(mark, app.label, several: false) }
                .accessibilityLabel("Open \(app.label)")
        } else {
            Menu {
                accounts(app)
            } label: {
                face(mark, app.label, several: true)
            }
            .accessibilityLabel("Open \(app.label): choose an account")
        }
    }

    @ViewBuilder private func accounts(_ app: PersonNow.Reach) -> some View {
        ForEach(app.accounts) { account in
            if let url = URL(string: account.open.url) {
                Link(destination: url) {
                    Label {
                        Text(account.title ?? account.handle)
                        if account.title != nil { Text(account.handle) }
                    } icon: {
                        Image(systemName: "arrow.up.right")
                    }
                }
            }
        }
    }

    private func face(_ mark: some View, _ label: String, several: Bool) -> some View {
        VStack(spacing: Metrics.Spacing.xs) {
            mark
            HStack(spacing: 2) {
                Text(label).lineLimit(1).minimumScaleFactor(0.8)
                if several { Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(Palette.muted) }
            }
            .font(.reachLabel).foregroundStyle(Palette.fg)
        }
        .padding(.vertical, Metrics.Spacing.m)
        .frame(maxWidth: .infinity)
        .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
        .contentShape(.rect)
    }
}

/// What is open with them, under `label`: at most three rows of the Matters list, all of them on "All n".
struct OpenMatters: View {
    let label: String
    let now: PersonNow
    @State private var isAll = false

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    var body: some View {
        if !now.open.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Text(label).font(.small).foregroundStyle(Palette.muted)
                    .padding(.horizontal, Metrics.gutter).padding(.bottom, Metrics.Spacing.xs)
                ForEach(isAll ? now.open : Array(now.open.prefix(3))) { row in
                    Button {
                        router.open(matter: row.id)
                    } label: {
                        MatterRowView(row: row, isChosen: false, isMarked: life.isImportant(row.id, as: row.important))
                    }
                    .buttonStyle(.plain)
                    .appears()
                }
                if !isAll, now.openCount > 3 {
                    TextLink("All \(now.openCount)", isOnward: true) { isAll = true }
                        .padding(.horizontal, Metrics.gutter)
                }
            }
            .padding(.horizontal, -Metrics.gutter)
            .motion(Motion.standard, value: isAll)
        }
    }
}

/// Lately: their situation, Life's lines, four lines at most until More.
private struct Lately: View {
    let lines: [String]
    @State private var isWhole = false

    var body: some View {
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
                Text("Lately").font(.small).foregroundStyle(Palette.muted)
                Text(lines.joined(separator: " ")).font(.body15).foregroundStyle(Palette.fg)
                    .lineLimit(isWhole ? nil : 4).fixedSize(horizontal: false, vertical: true)
                if !isWhole { TextLink("More") { isWhole = true } }
            }
            .padding(Metrics.Spacing.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
            .motion(Motion.standard, value: isWhole)
        }
    }
}

/// Their details as rows: a glyph, the value, what it is; a handle reach does not cover has a copy button.
private struct Details: View {
    let details: [PersonNow.Detail]

    var body: some View {
        if !details.isEmpty {
            VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                ForEach(Array(details.enumerated()), id: \.offset) { _, detail in DetailRow(detail: detail) }
            }
            .padding(Metrics.Spacing.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
        }
    }
}

private struct DetailRow: View {
    let detail: PersonNow.Detail
    @State private var isCopied = false

    var body: some View {
        let (value, what) = detail.shown()
        HStack(spacing: Metrics.Spacing.m) {
            Image(systemName: glyph(value)).foregroundStyle(Palette.muted).frame(width: Metrics.Spacing.xl)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(value).font(.body15).foregroundStyle(Palette.fg)
                Text(what).font(.small).foregroundStyle(Palette.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            if detail.isCopied {
                Button(isCopied ? "Copied" : "Copy \(value)", systemImage: isCopied ? "checkmark" : "doc.on.doc") {
                    UIPasteboard.general.string = value
                    isCopied = true
                }
                .labelStyle(.iconOnly).buttonStyle(.glass).buttonBorderShape(.circle)
                .task(id: isCopied) {
                    guard isCopied, (try? await Task.sleep(for: .seconds(2))) != nil else { return }
                    isCopied = false
                }
            }
        }
    }

    private func glyph(_ value: String) -> String {
        switch detail.kind {
        case .birthday: "birthday.cake"
        case .home: "mappin"
        case .work: "building.2"
        case .family: "person.2"
        case .handles, .unknown: value.contains("@") ? "envelope" : "phone"
        }
    }
}

/// What Life knows: a row for each part it holds (the first sentence of it under its title), and how each writes to
/// the other; each opens a page of its own.
private struct Knows: View {
    let now: PersonNow
    let ref: String

    var body: some View {
        let parts = now.knows.map { known in
            KnownRow(
                title: now.title(of: known), first: known.first,
                route: .part(ref: known.ref, title: now.title(of: known)))
        }
        let writing = now.communicationStyle.first.map {
            KnownRow(title: "How you write to each other", first: $0.text, route: .writing(ref))
        }
        let rows = parts + [writing].compactMap(\.self)
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
                Text("What Life knows").font(.small).foregroundStyle(Palette.muted)
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { at, row in
                        if at > 0 { Hairline() }
                        NavigationLink(value: row.route) {
                            HStack(spacing: Metrics.Spacing.m) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(row.title).font(.rowName).foregroundStyle(Palette.fg)
                                    Text(row.first).font(.note).foregroundStyle(Palette.muted).lineLimit(1)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                Image(systemName: "chevron.right").font(.small).foregroundStyle(Palette.muted)
                                    .accessibilityHidden(true)
                            }
                            .padding(.vertical, Metrics.Spacing.m)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, Metrics.Spacing.l)
                .card()
            }
        }
    }
}

private struct KnownRow {
    let title: String
    let first: String
    let route: AppRouter.PersonRoute
}

/// Latest, the bottom of the page: their newest exchanges across every channel, then Earlier, which pages back.
struct Latest: View {
    let subject: String
    /// "Latest" on a person's page, five exchanges and Earlier; "Last exchange" on an organization's, one.
    var label = "Latest"
    var count: Int?

    @Environment(LifeStore.self) private var life

    var body: some View {
        let ref = subject + "/latest"
        Group {
            if let page = life.latest[ref]?.value, !page.latest.isEmpty {
                VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                    Text(label).font(.small).foregroundStyle(Palette.muted)
                    ForEach(page.latest.prefix(count ?? page.latest.count)) { item in
                        ExchangeView(item: item, when: SaidWords.moment(item.at))
                    }
                    if count == nil, page.nextBefore != nil {
                        NavigationLink(value: AppRouter.PersonRoute.latest(subject)) {
                            Text("Earlier \(Image(systemName: "chevron.right"))").font(.smallStrong)
                                .foregroundStyle(Palette.fg)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .appears()
            }
        }
        .task(id: life.parties.generation.current) { await life.refreshLatest(ref) }
    }
}

/// One exchange as it reads: where and when (the app's mark, the out-arrow to the chat), then its words, two lines at
/// most each, his on the right on `fillTint`, theirs on the left on `tile`: a chat's sides, not bubbles. A conversation
/// in person is its summary.
struct ExchangeView: View {
    let item: LatestPage.Item
    let when: String

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            HStack(spacing: Metrics.Spacing.s) {
                if item.isHeard {
                    Image(systemName: "waveform").font(.small).foregroundStyle(Palette.muted)
                } else {
                    NetworkMark(network: item.channel, size: 14)
                }
                Text((item.isHeard ? "In person" : Channel.name(item.channel)) + " · " + when)
                    .font(.small).foregroundStyle(Palette.muted)
                if let url = item.open.flatMap({ URL(string: $0.url) }) {
                    Button("Open the chat", systemImage: "arrow.up.right") { openURL(url) }
                        .labelStyle(.iconOnly).font(.small).foregroundStyle(Palette.muted)
                }
            }
            if let summary = item.summary {
                said(summary, isHis: false)
            }
            ForEach(Array((item.lines ?? []).prefix(2).enumerated()), id: \.offset) { _, line in
                said(line.text, isHis: line.by == .him)
            }
        }
    }

    private func said(_ text: String, isHis: Bool) -> some View {
        Text(text).font(.body15).foregroundStyle(Palette.fg).lineLimit(2)
            .multilineTextAlignment(isHis ? .trailing : .leading)
            .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.m)
            .background(isHis ? Color.fillTint : Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
            .containerRelativeFrame(.horizontal, alignment: isHis ? .trailing : .leading) { width, _ in width * 0.88 }
            .frame(maxWidth: .infinity, alignment: isHis ? .trailing : .leading)
    }
}
