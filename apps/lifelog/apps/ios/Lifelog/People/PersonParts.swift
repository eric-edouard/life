import LifeConnector
import SwiftUI

// The pages a person's page opens, read only: a part of what Life holds about them as prose, how each writes to the
// other, and every exchange paging back. Each has the part's name as its head and the person's name under it.

/// A prose part (`page`, `persona`, `story`, `evidence`) by its ref: its sections under small labels, long-form.
struct ProsePage: View {
    let ref: String
    let title: String

    @Environment(LifeStore.self) private var life

    var body: some View {
        let state = life.prose[ref] ?? ReadState()
        ReadScreen(
            shown: state.shown(isEmpty: { $0.sections.isEmpty }), retry: { await life.refreshProse(ref) },
            loading: { PagePlaceholder() },
            empty: { Notice(title: "Nothing here yet.", detail: "Life writes this part as it learns more.") },
            content: { prose in
                SubPage(title: title, subject: subject(of: ref)) {
                    ForEach(prose.sections) { section in
                        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
                            if let label = section.label { Text(label).font(.small).foregroundStyle(Palette.muted) }
                            ForEach(Array(section.paragraphs.enumerated()), id: \.offset) { _, paragraph in
                                Text(paragraph).font(.lead).foregroundStyle(Palette.fg).lineSpacing(Metrics.Spacing.xs)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }
        )
        .background(Palette.bg)
        .shellBar("")
        .task { await life.refreshProse(ref) }
    }
}

/// How each writes to the other: the lines of their communication style, from their `now`.
struct WritingPage: View {
    let subject: String

    @Environment(LifeStore.self) private var life

    var body: some View {
        SubPage(title: "How you write to each other", subject: subject) {
            ForEach(Array((life.person[subject]?.value?.communicationStyle ?? []).enumerated()), id: \.offset) {
                _, line in
                Text(line.text).font(.lead).foregroundStyle(Palette.fg).lineSpacing(Metrics.Spacing.xs)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .background(Palette.bg)
        .shellBar("")
    }
}

/// Every exchange with them, newest first under its day, paging back by Earlier (`latest` with `before`).
struct LatestScreen: View {
    let subject: String

    @Environment(LifeStore.self) private var life
    /// The pages asked beyond the first, in order: each the one before the last.
    @State private var earlier: [String] = []

    private var first: String { subject + "/latest" }

    var body: some View {
        let state = life.latest[first] ?? ReadState()
        ReadScreen(
            shown: state.shown(isEmpty: { $0.latest.isEmpty }), retry: { await life.refreshLatest(first) },
            loading: { PagePlaceholder() },
            empty: { Notice(title: "Nothing exchanged yet.", detail: "Their messages, mail and talks show here.") },
            content: { _ in
                SubPage(title: "Latest", subject: subject) {
                    let pages = ([first] + earlier).compactMap { life.latest[$0]?.value }
                    let items = pages.flatMap(\.latest)
                    ForEach(Array(items.enumerated()), id: \.element.id) { at, item in
                        let day = SaidWords.day(item.at)
                        if at == 0 || SaidWords.day(items[at - 1].at) != day {
                            Text(day).font(.small).foregroundStyle(Palette.muted).padding(.top, Metrics.Spacing.s)
                        }
                        ExchangeView(item: item, when: SaidWords.time(item.at))
                    }
                    let last = ([first] + earlier).last ?? first
                    if let next = life.latest[last]?.value?.earlier(of: subject) {
                        TextLink("Earlier", isOnward: true) { earlier.append(next) }
                    } else if life.latest[last]?.phase == .loading {
                        Spinner()
                    }
                }
            }
        )
        .background(Palette.bg)
        .shellBar("")
        .task { await life.refreshLatest(first) }
        .task(id: earlier.last) {
            if let ref = earlier.last { await life.refreshLatest(ref) }
        }
    }
}

/// A sub-page's frame: its name as the head, the person's name under it, then its content, at a reading width.
private struct SubPage<Content: View>: View {
    let title: String
    let subject: String
    @ViewBuilder let content: Content

    @Environment(LifeStore.self) private var life

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                    Text(title).font(.screenName).foregroundStyle(Palette.fg)
                        .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                    if let name = life.person[subject]?.value?.row.party.name {
                        Text(name).font(.body15).foregroundStyle(Palette.muted)
                    }
                }
                content
            }
            .padding(.horizontal, Metrics.gutter).padding(.top, Metrics.Spacing.s).padding(.bottom, Metrics.Spacing.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
            .readingWidth()
        }
    }
}

/// The subject of a part's ref: `person:camille/page` gives `person:camille`.
private func subject(of ref: String) -> String {
    String(ref.prefix { $0 != "/" })
}
