import SwiftUI

/// Life's voice mark: five rounded bars, the middle tallest. `isLive` moves them (his voice).
struct TellMark: View {
    var size: CGFloat = 24
    var color = Palette.ai
    var isLive = false

    private static let heights: [CGFloat] = [0.4, 0.7, 1, 0.7, 0.4]

    var body: some View {
        HStack(spacing: size / 8) {
            ForEach(Self.heights.indices, id: \.self) { bar in
                Capsule().fill(color).frame(width: size / 8, height: size * Self.heights[bar])
                    .phaseAnimator([1, 0.5], trigger: isLive) { view, phase in
                        view.scaleEffect(y: isLive ? (bar.isMultiple(of: 2) ? phase : 1.5 - phase) : 1)
                    } animation: { _ in
                        .easeInOut(duration: 0.4)
                    }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The line of light (the lit look): the stage's one drawing, which changes between states and never cuts. Ready: a
/// breathing hairline. Thinking: drawn into one dot, two rings leaving it. Answer: a short bar over the words. Error:
/// broken in `flag`. Offline: dots.
struct TellLine: View {
    enum Kind { case ready, point, answer, broken, waiting }
    let kind: Kind

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            switch kind {
            case .ready:
                hairline.phaseAnimator([0.45, 1]) {
                    $0.opacity(reduceMotion ? 1 : $1)
                } animation: { _ in
                    .easeInOut(duration: 1.6)
                }
            case .point: point
            case .answer:
                Capsule().fill(Palette.ai).frame(width: 36, height: 3).shadow(color: Palette.ai.opacity(0.6), radius: 8)
            case .broken:
                HStack(spacing: Metrics.Spacing.m) {
                    Capsule().fill(Palette.flag).frame(width: 90, height: 2)
                    Capsule().fill(Palette.flag).frame(width: 60, height: 2).offset(y: 3)
                }
            case .waiting:
                HStack(spacing: Metrics.Spacing.s) {
                    ForEach(0..<9, id: \.self) { _ in Circle().fill(Palette.muted).frame(width: 3, height: 3) }
                }
            }
        }
        .frame(height: 40)
        .motion(Motion.standard, value: kind)
        .accessibilityHidden(true)
    }

    /// Fading at its ends, with a soft bloom under it.
    private var hairline: some View {
        LinearGradient(colors: [.clear, Palette.ai, .clear], startPoint: .leading, endPoint: .trailing)
            .frame(height: 2).shadow(color: Palette.ai.opacity(0.5), radius: 10, y: 4)
    }

    private var point: some View {
        ZStack {
            Circle().fill(Palette.ai).frame(width: 8, height: 8).shadow(color: Palette.ai, radius: 8)
            if !reduceMotion {
                ForEach(0..<2, id: \.self) { ring in
                    Circle().stroke(Palette.ai.opacity(0.5), lineWidth: 1).frame(width: 8, height: 8)
                        .phaseAnimator([1, 6]) { view, scale in
                            view.scaleEffect(scale).opacity(scale == 1 ? 0.8 : 0)
                        } animation: { _ in
                            .easeOut(duration: 1.6).delay(Double(ring) * 0.5)
                        }
                }
            }
        }
    }
}

/// One piece of work: what it is above a hairline, a short run of `ai` moving along it while it runs; done, the
/// hairline full and still with a check.
struct TellStrandRow: View {
    let title: String
    let isDone: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            HStack(spacing: Metrics.Spacing.s) {
                Text(title).font(.small).foregroundStyle(isDone ? Palette.muted : Palette.fg).lineLimit(1)
                if isDone { Image(systemName: "checkmark").font(.chip).foregroundStyle(Palette.ok) }
            }
            ZStack(alignment: .leading) {
                Capsule().fill(Color.fillTint)
                if isDone { Capsule().fill(Palette.ok.opacity(0.6)) } else { run }
            }
            .frame(height: 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityValue(isDone ? "done" : "working")
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var run: some View {
        GeometryReader { proxy in
            Capsule().fill(Palette.ai).frame(width: proxy.size.width * 0.25)
                .phaseAnimator([0, 0.75]) { view, at in
                    view.offset(x: reduceMotion ? 0 : proxy.size.width * at)
                } animation: { _ in
                    .easeInOut(duration: 1.2)
                }
        }
    }
}
