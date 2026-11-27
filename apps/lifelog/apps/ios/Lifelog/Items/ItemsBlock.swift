import LifeConnector
import SwiftUI

/// Life's `items` block: the asks its refs name, as live rows. A ref the newest read does not hold shows nothing.
/// `isOnTheirMatter`: drawn on their matter's page, so each row says its question, not the matter's name again.
struct ItemsBlock: View {
    let refs: [String]
    var isOnTheirMatter = false
    @Environment(LifeStore.self) private var life

    /// The prototype's `.fc` list: one row per ask, top to bottom (`rowHTML`); a single ask in an answer arrives unfolded.
    var body: some View {
        // Every voice to name folds into the one row, last, as on the opening screen.
        let asks = refs.compactMap { life.ask($0) }.filter { $0.check?.group != .voice }
        let hasVoices = refs.contains { life.ask($0)?.check?.group == .voice } || refs.contains(OpeningScreen.voices)
        // The prototype's rows sit 7 pt above and below with 2 between (`.fc .fr`): about 12 from row to row.
        VStack(spacing: Metrics.Spacing.m) {
            ForEach(asks) {
                ItemRow(ask: $0, isOnTheirMatter: isOnTheirMatter, startsOpen: asks.count == 1 && $0.isAnswerable)
            }
            if hasVoices { VoicesRow() }
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
