import SwiftUI

/// The Pendant sheet's visual pieces (`VisPendant*` frames): a tile holds one fact drawn as a picture, never a row.

/// A battery drawn as a battery: a case in the quiet tint, a fill that is the charge, the little terminal.
struct BatteryMeter: View {
    let fraction: Double
    var tone: Color = Palette.fg

    var body: some View {
        HStack(spacing: 2) {
            RoundedRectangle(cornerRadius: 9).fill(Color.fillTint)
                .overlay(alignment: .leading) {
                    GeometryReader { proxy in
                        RoundedRectangle(cornerRadius: 6).fill(tone)
                            .frame(width: max((proxy.size.width - 6) * min(max(fraction, 0), 1), 8))
                            .padding(3)
                    }
                }
                .frame(width: 71, height: 34)
            UnevenRoundedRectangle(bottomTrailingRadius: 2, topTrailingRadius: 2).fill(Color.fillTint)
                .frame(width: 3, height: 12)
        }
        .motion(Motion.standard, value: fraction)
        .accessibilityHidden(true)
    }
}

/// A ring that fills clockwise from the top: how much of something is used.
struct RingMeter: View {
    let fraction: Double
    var tone: Color = Palette.fg

    var body: some View {
        ZStack {
            Circle().stroke(Color.fillTint, lineWidth: 6)
            Circle().trim(from: 0, to: min(max(fraction, 0), 1))
                .stroke(tone, style: .init(lineWidth: 6, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 46, height: 46).padding(5)
        .motion(Motion.standard, value: fraction)
        .accessibilityHidden(true)
    }
}

/// A tile with a picture at one top corner and, bottom left, a figure and what it counts.
struct StatTile<Visual: View>: View {
    let figure: String
    let caption: String
    var figureColor = Palette.fg
    var isDim = false
    var visualEdge = Alignment.topLeading
    @ViewBuilder var visual: Visual

    var body: some View {
        ZStack {
            visual.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: visualEdge)
            VStack(alignment: .leading, spacing: 0) {
                Text(figure).font(.tileFigure).foregroundStyle(figureColor)
                if !caption.isEmpty { Text(caption).font(.small).foregroundStyle(Palette.muted) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        }
        .padding(16)
        .frame(maxWidth: .infinity).frame(height: 128)
        .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.card))
        .opacity(isDim ? 0.6 : 1)
        .motion(Motion.standard, value: isDim)
        .accessibilityElement(children: .combine)
    }
}

/// The pendant's light as a tile: the lens is lit and breathing while it records, a quiet dot when it does not.
struct LightTile: View {
    var isOn: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: Metrics.Radius.player).fill(Palette.tile).frame(width: 84, height: 84)
            .overlay { StateDot(color: isOn ? Palette.fg : Palette.muted, isLit: isOn).scaleEffect(1.15) }
            .opacity(isOn ? 1 : 0.4)
            .motion(Motion.standard, value: isOn)
            .accessibilityHidden(true)
    }
}

/// A track filled by how far it got; while `isActive` a light sweeps along it, so waiting reads as work under way.
/// `fraction` nil is a wait of unknown length: the sweep alone.
struct ProgressTrack: View {
    var fraction: Double?
    var isActive = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sweep = false

    var body: some View {
        Capsule().fill(Color.fillTint).frame(height: 6)
            .overlay(alignment: .leading) {
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Palette.fg).frame(width: proxy.size.width * min(max(fraction ?? 0, 0), 1))
                        if isActive && !reduceMotion {
                            Capsule().fill(
                                LinearGradient(
                                    colors: [.clear, Palette.fg.opacity(fraction == nil ? 0.9 : 0.4), .clear],
                                    startPoint: .leading, endPoint: .trailing)
                            )
                            .frame(width: proxy.size.width * 0.4)
                            .offset(x: sweep ? proxy.size.width * 1.1 : -proxy.size.width * 0.5)
                        }
                    }
                }
            }
            .clipShape(.capsule)
            .motion(Motion.standard, value: fraction)
            .onAppear {
                guard isActive && !reduceMotion else { return }
                withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) { sweep = true }
            }
            .accessibilityHidden(true)
    }
}

/// A full-width tile for one line of standing: "All on your Mac", "Last seen 13:20", or what is catching up.
struct TileCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(.horizontal, 16).padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.card))
    }
}
