import SwiftUI

/// The Pendant sheet's pieces (`VisPendant*` frames): a tile holds one fact drawn as a picture, never a row.

/// A ring that fills clockwise from the top: how much of something is used.
struct RingMeter: View {
    let fraction: Double
    var tone: Color = Palette.fg

    var body: some View {
        ZStack {
            Circle().inset(by: 3).stroke(Palette.tint, lineWidth: 6)
            Circle().inset(by: 3).trim(from: 0, to: min(max(fraction, 0), 1))
                .stroke(tone, style: .init(lineWidth: 6, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: Metrics.Tile.ring, height: Metrics.Tile.ring)
        .motion(Motion.standard, value: fraction)
        .accessibilityHidden(true)
    }
}

/// A tile with a picture at one top corner and, bottom left, a figure and what it counts. Read as one sentence
/// ("Battery 82%, about 3 days"), the figure never hidden by the label.
struct StatTile<Visual: View>: View {
    let name: String
    let figure: String
    var caption: String?
    var figureColor = Palette.fg
    var isDim = false
    var visualEdge = Alignment.topLeading
    @ViewBuilder var visual: Visual
    @Environment(\.dynamicTypeSize) private var size

    var body: some View {
        let words = VStack(alignment: .leading, spacing: 0) {
            // Beside the ring a long figure ("Unknown") shrinks to its line; at the largest sizes the tile stacks.
            Text(figure).font(.profileName).foregroundStyle(figureColor)
                .lineLimit(size.isAccessibilitySize ? nil : 1).minimumScaleFactor(size.isAccessibilitySize ? 1 : 0.6)
            if let caption { Text(caption).font(.line).foregroundStyle(Palette.muted) }
        }
        .fixedSize(horizontal: false, vertical: true)
        Group {
            // At the accessibility sizes the picture sits above the words, so no figure is cut.
            if size.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                    visual.frame(maxWidth: .infinity, alignment: visualEdge)
                    words.frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                ZStack {
                    visual.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: visualEdge)
                    words.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                }
            }
        }
        .padding(Metrics.Spacing.l)
        .frame(maxWidth: .infinity).frame(minHeight: Metrics.Tile.statHeight)
        .background(Surface.sheet.fill, in: .rect(cornerRadius: Metrics.Radius.block))
        .opacity(isDim ? 0.6 : 1)
        .motion(Motion.standard, value: isDim)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name) \(figure)\(caption.map { ", \($0)" } ?? "")")
    }
}

/// The pendant's light as a tile: the lens is lit and breathing while it records, a quiet dot when it does not.
struct LightTile: View {
    var isOn: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: Metrics.Radius.block).fill(Surface.sheet.fill)
            .frame(width: Metrics.Tile.light, height: Metrics.Tile.light)
            .overlay { StateDot(color: isOn ? Palette.fg : Palette.muted, isLit: isOn).scaleEffect(1.15) }
            .opacity(isOn ? 1 : 0.4)
            .motion(Motion.standard, value: isOn)
            .accessibilityHidden(true)
    }
}

/// A full-width tile for one line of standing: "All on your Mac", "Last seen 13:20", or what is catching up.
struct TileCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .fixedSize(horizontal: false, vertical: true)
            .padding(Metrics.Spacing.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Surface.sheet.fill, in: .rect(cornerRadius: Metrics.Radius.block))
    }
}
