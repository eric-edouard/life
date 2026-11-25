import LifeConnector
import SwiftUI

/// Life's `items` block: the asks its refs name, as live rows. A ref the newest read does not hold shows nothing.
struct ItemsBlock: View {
    let refs: [String]
    @Environment(LifeStore.self) private var life

    var body: some View {
        VStack(spacing: 0) {
            ForEach(refs, id: \.self) { ref in
                if let ask = life.ask(ref) { ItemRow(ask: ask) }
            }
        }
    }
}

/// Life's `pictures` block: the people and organizations its refs name, as faces that open their profile.
struct PicturesBlock: View {
    let refs: [String]
    @Environment(LifeStore.self) private var life
    @State private var opened: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Metrics.Spacing.m) {
                ForEach(refs, id: \.self) { ref in
                    if let party = life.parties.byRef[ref] {
                        Button {
                            opened = ref
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
        .sheet(item: $opened) { ref in ProfileView(ref: ref).sheetStack() }
    }
}

extension String: @retroactive Identifiable { public var id: String { self } }
