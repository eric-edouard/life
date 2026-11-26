import LifeConnector
import SwiftUI

/// Life's `items` block: the asks its refs name, as live rows. A ref the newest read does not hold shows nothing.
/// `isOnTheirMatter`: drawn on their matter's page, so each row says its question, not the matter's name again.
struct ItemsBlock: View {
    let refs: [String]
    var isOnTheirMatter = false
    @Environment(LifeStore.self) private var life
    @State private var page: String?

    /// A short list of his asks (2 to 7) goes sideways, one full card a page with the next peeking and dots (the lab's
    /// A, owner 26 Nov 2026); a longer one, or one on a matter's page, stays a vertical list.
    private static let sideways = 2...7

    var body: some View {
        let asks = refs.compactMap { life.ask($0) }
        if Self.sideways.contains(asks.count), !isOnTheirMatter {
            VStack(spacing: Metrics.Spacing.m) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: Metrics.Spacing.m) {
                        ForEach(asks) { ask in
                            ItemRow(ask: ask, startsOpen: true)
                                .containerRelativeFrame(.horizontal) { width, _ in width - Metrics.Spacing.xl }
                                .id(ask.ref)
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.viewAligned).scrollPosition(id: $page).scrollClipDisabled()
                HStack(spacing: Metrics.Spacing.s) {
                    ForEach(asks) { ask in
                        Circle().fill(ask.ref == (page ?? asks.first?.ref) ? Palette.fg : Palette.faint)
                            .frame(width: Metrics.Spacing.s, height: Metrics.Spacing.s)
                    }
                }
                .accessibilityHidden(true)
            }
        } else {
            VStack(spacing: Metrics.Spacing.xs) {
                // A single ask in an answer arrives unfolded.
                ForEach(asks) {
                    ItemRow(ask: $0, isOnTheirMatter: isOnTheirMatter, startsOpen: asks.count == 1 && $0.isAnswerable)
                }
            }
        }
    }
}

/// Life's `pictures` block: the people and organizations its refs name, as faces that open their profile (`RootView.open`, as a `life:` link does).
struct PicturesBlock: View {
    let refs: [String]
    @Environment(LifeStore.self) private var life
    @Environment(\.openURL) private var openURL
    @Environment(\.profileZoom) private var zoom

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Metrics.Spacing.m) {
                ForEach(refs, id: \.self) { ref in
                    if let party = life.parties.byRef[ref] {
                        Button {
                            if let url = URL.lifeOpen(ref) { openURL(url) }
                        } label: {
                            VStack(spacing: Metrics.Spacing.xs) {
                                Face(party: party, size: 56).zoomSource(ref, in: zoom)
                                Text(party.name).font(.line).foregroundStyle(Palette.muted).lineLimit(1)
                            }
                            .frame(minWidth: Metrics.tapTarget)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

extension String: @retroactive Identifiable { public var id: String { self } }
