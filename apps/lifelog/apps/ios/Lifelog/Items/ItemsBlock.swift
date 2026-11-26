import LifeConnector
import SwiftUI

/// Life's `items` block: the asks its refs name, as live rows. A ref the newest read does not hold shows nothing.
/// `isOnTheirMatter`: drawn on their matter's page, so each row says its question, not the matter's name again.
struct ItemsBlock: View {
    let refs: [String]
    var isOnTheirMatter = false
    @Environment(LifeStore.self) private var life

    var body: some View {
        VStack(spacing: Metrics.Spacing.xs) {
            ForEach(refs, id: \.self) { ref in
                if let ask = life.ask(ref) { ItemRow(ask: ask, isOnTheirMatter: isOnTheirMatter) }
            }
        }
    }
}

/// Life's `pictures` block: the people and organizations its refs name, as faces that open their profile (`RootView.open`, as a `life:` link does).
struct PicturesBlock: View {
    let refs: [String]
    @Environment(LifeStore.self) private var life
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Metrics.Spacing.m) {
                ForEach(refs, id: \.self) { ref in
                    if let party = life.parties.byRef[ref] {
                        Button {
                            if let url = URL.lifeOpen(ref) { openURL(url) }
                        } label: {
                            VStack(spacing: Metrics.Spacing.xs) {
                                Face(party: party, size: 56)
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
