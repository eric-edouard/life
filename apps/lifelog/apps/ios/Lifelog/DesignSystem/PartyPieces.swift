import LifeConnector
import SwiftUI
import UIKit

// One way to show a person or an organization, everywhere (`party_*` in the design's `parts.py`): one disc, and the
// row, the answer, the chip and a draft's head built on it. Someone Life has not placed yet (a name being asked, a
// guess) is drawn by name only: never a picture.

/// The one disc of a person or an organization, at 20, 28, 40 or 72: their picture when Life has one, else their
/// initials on `fillTint`, a building for an organization. A network's mark sits at its lower right, on a disc of `ring`
/// (the fill the disc stands on), only where the channel is the point (a draft's recipient, an identity to confirm),
/// never in a list.
struct PartyDisc: View {
    enum Size: CGFloat {
        case chip = 20, pick = 28, row = 40, page = 72

        /// The initials' size, in the disc's own scale: they never grow with Dynamic Type.
        fileprivate var initials: Font {
            let points: CGFloat =
                switch self {
                case .chip: 9
                case .pick: 11
                case .row: 14
                case .page: 24
                }
            return TypeStep(size: points, weight: 600, style: .caption2).font(at: .large)
        }
    }

    private let name: String
    private let isOrganization: Bool
    private let pictureID: String?
    private let size: Size
    private let badge: String?
    private let ring: Color

    @Environment(PictureCache.self) private var pictures: PictureCache?

    init(_ party: Party, size: Size, badge: String? = nil, ring: Color = Palette.bg) {
        (name, isOrganization, pictureID) = (party.name, party.kind == .organization, party.picture?.id)
        (self.size, self.badge, self.ring) = (size, badge, ring)
    }

    /// Someone Life has not placed: initials, or the person glyph for a number.
    init(name: String, size: Size, badge: String? = nil, ring: Color = Palette.bg) {
        (self.name, isOrganization, pictureID, self.size, self.badge, self.ring) = (name, false, nil, size, badge, ring)
    }

    var body: some View {
        let side = size.rawValue
        face.frame(width: side, height: side).background(Color.fillTint).clipShape(.circle)
            .overlay(alignment: .bottomTrailing) {
                if let badge {
                    let dot = (side * 0.4).rounded()
                    NetworkMark(network: badge, size: dot - (size == .page ? 4 : 2))
                        .frame(width: dot, height: dot).background(ring, in: .circle)
                        .offset(x: side * 0.05, y: side * 0.05)
                }
            }
            .accessibilityHidden(true)
    }

    @ViewBuilder private var face: some View {
        let initials = SaidWords.initials(name).filter(\.isLetter)
        if let data = pictureID.flatMap({ pictures?.shown[$0] }), let picture = UIImage(data: data) {
            Image(uiImage: picture).resizable().scaledToFill()
        } else if isOrganization {
            Image(systemName: "building.2").resizable().scaledToFit().padding(size.rawValue * 0.25)
                .foregroundStyle(Palette.muted)
        } else if initials.isEmpty {
            Image(systemName: "person").resizable().scaledToFit().padding(size.rawValue * 0.28)
                .foregroundStyle(Palette.muted)
        } else {
            Text(initials).font(size.initials).foregroundStyle(Palette.fg)
        }
    }
}

/// A person or an organization as a row of a list (`party_row`): the disc (40), the name, one `muted` line (theirs,
/// unless the list gives its own: a role, "Mother"), and what ends the row (nothing, a chevron, a check). Dimmed, it is
/// someone quieter in its list (only seen by Life, no longer there), never disabled.
struct PartyRow<End: View>: View {
    let party: Party
    var line: String?
    var isDim = false
    @ViewBuilder var end: End

    var body: some View {
        HStack(spacing: Metrics.Spacing.m) {
            PartyDisc(party, size: .row)
            VStack(alignment: .leading, spacing: 2) {
                Text(party.name).font(.rowName).foregroundStyle(Palette.fg)
                if let line = line ?? party.line { Text(line).font(.note).foregroundStyle(Palette.muted) }
            }
            .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            end
        }
        .opacity(isDim ? 0.6 : 1)
        .accessibilityElement(children: .combine)
    }
}

extension PartyRow where End == EmptyView {
    init(_ party: Party, line: String? = nil, isDim: Bool = false) {
        self.init(party: party, line: line, isDim: isDim) {}
    }
}

/// A person as an answer on a card (`party_pick`: naming a voice, a name with candidates): the answers' capsule, 56
/// high on `tile`, holding the disc (28), the name and their line.
struct PartyPick: View {
    let party: Party
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Metrics.Spacing.m) {
                PartyDisc(party, size: .pick)
                VStack(alignment: .leading, spacing: 1) {
                    Text(party.name).font(.buttonLabel).foregroundStyle(Palette.fg)
                    if let line = party.line { Text(line).font(.small).foregroundStyle(Palette.muted).lineLimit(1) }
                }
                .multilineTextAlignment(.leading)
            }
            .accessibilityElement(children: .combine)
        }
        .buttonStyle(PickStyle())
    }

    private struct PickStyle: ButtonStyle {
        func makeBody(configuration: Configuration) -> some View {
            configuration.label
                .padding(.leading, 14).padding(.trailing, Metrics.Spacing.l)
                .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                .background(Palette.tile, in: .capsule)
                .opacity(configuration.isPressed ? 0.7 : 1).contentShape(.capsule)
        }
    }
}

/// A person inside a line of text (`party_chip`): `label` in `muted` ("Owed to", "with"), the disc (20), then the name
/// in the line's own type, in `fg`. The 20 disc sits inside the line's height.
struct PartyChip: View {
    let party: Party
    var label: String?

    var body: some View {
        HStack(spacing: 6) {
            if let label { Text(label).foregroundStyle(Palette.muted) }
            PartyDisc(party, size: .chip).padding(.vertical, -2)
            Text(party.name).foregroundStyle(Palette.fg)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Who a draft goes to (`party_head`): the disc (40) with the app's mark, the name, and under it the app in words then
/// the handle, one `muted` line whose handle is what is cut.
struct PartyHead: View {
    /// Who Life holds them to be, for the disc; none for someone it only guesses, drawn by name.
    let party: Party?
    /// The name he reads: the draft's own.
    let name: String
    let channel: String?
    let handle: String?

    var body: some View {
        HStack(spacing: Metrics.Spacing.m) {
            if let party {
                PartyDisc(party, size: .row, badge: channel, ring: Palette.tile)
            } else {
                PartyDisc(name: name, size: .row, badge: channel, ring: Palette.tile)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(.chip).foregroundStyle(Palette.fg)
                Text([Channel.name(channel), handle].compactMap(\.self).joined(separator: " · "))
                    .font(.small).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.tail)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
