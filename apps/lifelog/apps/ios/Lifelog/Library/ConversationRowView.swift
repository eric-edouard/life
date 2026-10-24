import SwiftUI

/// One conversation in the journal: start time, duration and place in a narrow column, the title in Newsreader, one
/// line of summary (or the search snippet), people, photos from its time, where it stands while it isn't
/// done, and a mark while an edit of it waits for the server. At accessibility text sizes the column moves above the
/// title and the summary may wrap.
struct ConversationRowView: View {
    let row: ConversationRow
    /// The search text, to mark in the snippet.
    var query = ""

    /// Photos and screenshots from its time, once counted (`PhotoCount`).
    @State private var photos: Int?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout =
            stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        layout {
            times(stacked: stacked)
            VStack(alignment: .leading, spacing: 4) {
                title
                line
                facts(stacked: stacked)
                    .padding(.top, 3)
                if let badge = row.badge {
                    ProcessingBadge(title: badge.title, glyph: badge.glyph)
                        .padding(.top, 4)
                        .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 14)
        .motion(Motion.standard, value: row.state)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func times(stacked: Bool) -> some View {
        let layout = stacked ? AnyLayout(HStackLayout(spacing: 8)) : AnyLayout(FirstWidthStack(spacing: 3))
        layout {
            ZStack(alignment: .topLeading) {
                // Sizes the column for the widest time this locale writes, so every row lines up and none wraps.
                if !stacked {
                    Text(Self.widestTime).font(.monoTime).hidden().accessibilityHidden(true)
                }
                Text(row.start, format: .dateTime.hour().minute())
                    .font(.monoTime)
                    .foregroundStyle(Palette.textPrimary)
            }
            .fixedSize()
            // A search reaches across days: each result says which.
            if !query.isEmpty {
                Text(DayTitle.short(row.start))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Palette.textSecondary)
            }
            DurationText(.seconds(row.end.timeIntervalSince(row.start)))
                .foregroundStyle(Palette.textTertiary)
                .fixedSize()
            if let place = row.place {
                Text(place)
                    .font(.caption2)
                    .foregroundStyle(Palette.textSecondary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(stacked ? 1 : 2)
                    .padding(.top, stacked ? 0 : 2)
            }
        }
        .lineLimit(1)
        .padding(.top, stacked ? 0 : 3)
    }

    /// "10:58 PM" or "22:58": the longer of a late morning and a late evening time in this locale.
    private static let widestTime =
        [10, 22].compactMap {
            Calendar.current.date(bySettingHour: $0, minute: 58, second: 0, of: .now)?.formatted(
                .dateTime.hour().minute())
        }.max { $0.count < $1.count } ?? "10:58 PM"

    @ViewBuilder private var title: some View {
        if let title = row.title {
            Text(title)
                .font(.rowTitle)
                .foregroundStyle(Palette.textPrimary)
                .lineLimit(3)
        } else {
            Text(ConversationRow.untitledName(start: row.start))
                .font(.placeholderTitle)
                .foregroundStyle(Palette.textBody)
                .lineLimit(2)
        }
    }

    /// The snippet when searching, else the summary, else the first words said. Where it stands is the badge's.
    @ViewBuilder private var line: some View {
        let lines = typeSize.isAccessibilitySize ? 4 : (row.snippet == nil ? 1 : 3)
        if row.byMeaning {
            Label("By meaning", systemImage: "sparkle.magnifyingglass")
                .font(.caption)
                .foregroundStyle(Palette.textTertiary)
        }
        if let snippet = row.snippet {
            Text(Self.marking(query, in: snippet))
                .font(.subheadline)
                .foregroundStyle(Palette.textSecondary)
                .lineLimit(lines)
        } else if let text = row.summary ?? row.opening {
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Palette.textSecondary)
                .lineLimit(lines)
        }
    }

    @ViewBuilder private func facts(stacked: Bool) -> some View {
        let layout =
            stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: Tag.between))
        let photos = photos ?? PhotoCount.known(from: row.start, to: row.end)
        layout {
            if !row.people.isEmpty {
                Tag(systemImage: "person", value: Text(row.people.joined(separator: ", ")))
                    .foregroundStyle(Palette.textSecondary)
                    .lineLimit(1)
            }
            if let photos, photos > 0 {
                Tag(
                    systemImage: "photo", value: Text(photos, format: .number).font(.monoDetail),
                    spoken: Text("^[\(photos) photo](inflect: true)")
                )
                .foregroundStyle(Palette.textSecondary)
            }
            if row.editWaiting {
                Tag(systemImage: "arrow.triangle.2.circlepath", value: Text("Waiting to sync"))
                    .foregroundStyle(Palette.textSecondary)
            }
        }
        .font(.caption)
        .task(id: [row.start, row.end]) { self.photos = await PhotoCount.count(from: row.start, to: row.end) }
    }

    /// `snippet` with each occurrence of `query` in the primary text color.
    static func marking(_ query: String, in snippet: String) -> AttributedString {
        var text = AttributedString(snippet)
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return text }
        var searchRange = text.startIndex..<text.endIndex
        while let match = text[searchRange].range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) {
            text[match].foregroundColor = Palette.textPrimary
            text[match].inlinePresentationIntent = .stronglyEmphasized
            searchRange = match.upperBound..<text.endIndex
        }
        return text
    }
}

/// Stacks its subviews as wide as the first one: the others wrap or truncate to that width. Measures once per change
/// of its subviews, not once to size and again to place.
private struct FirstWidthStack: Layout {
    struct Cache {
        var width: CGFloat
        var heights: [CGFloat]
    }

    var spacing: CGFloat

    func makeCache(subviews: Subviews) -> Cache {
        let width = subviews.first?.sizeThatFits(.unspecified).width ?? 0
        return Cache(width: width, heights: heights(of: subviews, width: width))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let gaps = spacing * CGFloat(max(subviews.count - 1, 0))
        return CGSize(width: cache.width, height: cache.heights.reduce(0, +) + gaps)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        let heights = bounds.width == cache.width ? cache.heights : heights(of: subviews, width: bounds.width)
        var y = bounds.minY
        for (subview, height) in zip(subviews, heights) {
            subview.place(
                at: CGPoint(x: bounds.minX, y: y), proposal: ProposedViewSize(width: bounds.width, height: nil))
            y += height + spacing
        }
    }

    private func heights(of subviews: Subviews, width: CGFloat) -> [CGFloat] {
        subviews.map { $0.sizeThatFits(ProposedViewSize(width: width, height: nil)).height }
    }
}
