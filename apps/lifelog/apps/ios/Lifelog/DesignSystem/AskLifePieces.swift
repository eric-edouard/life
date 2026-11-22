import SwiftUI

/// Life's voice mark: five rounded bars, the middle tallest. `isLive` moves them (his voice).
struct AskLifeMark: View {
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
struct AskLifeLightLine: View {
    enum Kind { case ready, point, answer, broken, waiting }
    let kind: Kind

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(AskLifeLook.key) private var look = AskLifeLook.lit

    var body: some View {
        // The Grotesk look has no line: the words stand alone.
        if look == .lit { line }
    }

    private var line: some View {
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
struct AskLifeStrandRow: View {
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

/// Life's L from the brand mark (`assets/brand/life-l.svg`), in a 492 x 625 box.
private struct LifeL: Shape {
    nonisolated func path(in rect: CGRect) -> Path {
        let k = rect.height / 625
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * k, y: rect.minY + y * k) }
        var path = Path()
        path.move(to: p(14, 625))
        path.addQuadCurve(to: p(12, 619), control: p(12, 625))
        path.addQuadCurve(to: p(14.5, 613), control: p(12, 613))
        path.addQuadCurve(to: p(55, 608), control: p(40.9, 613))
        path.addQuadCurve(to: p(76.2, 588), control: p(69, 603))
        path.addQuadCurve(to: p(88, 544), control: p(83.5, 573))
        path.addLine(to: p(170, 81))
        path.addQuadCurve(to: p(168, 25), control: p(178, 38))
        path.addQuadCurve(to: p(119.6, 12), control: p(158, 12))
        path.addQuadCurve(to: p(118, 6), control: p(118, 12))
        path.addQuadCurve(to: p(120.2, 0), control: p(118, 0))
        path.addQuadCurve(to: p(170.1, 1.5), control: p(142.7, 0))
        path.addQuadCurve(to: p(229, 3), control: p(197.6, 3))
        path.addQuadCurve(to: p(290.6, 1.5), control: p(261.2, 3))
        path.addQuadCurve(to: p(342, 0), control: p(320, 0))
        path.addQuadCurve(to: p(344, 6), control: p(344, 0))
        path.addQuadCurve(to: p(342, 12), control: p(344, 12))
        path.addQuadCurve(to: p(301, 17.5), control: p(315, 12))
        path.addQuadCurve(to: p(280.2, 38), control: p(287, 23))
        path.addQuadCurve(to: p(268, 82), control: p(273.4, 53))
        path.addLine(to: p(187, 540))
        path.addQuadCurve(to: p(187.5, 592.1), control: p(180, 580.1))
        path.addQuadCurve(to: p(223, 604), control: p(195, 604))
        path.addLine(to: p(249, 604))
        path.addQuadCurve(to: p(379, 567.5), control: p(323, 604))
        path.addQuadCurve(to: p(480, 454), control: p(435, 531))
        path.addQuadCurve(to: p(487, 453), control: p(482, 452))
        path.addQuadCurve(to: p(491, 457), control: p(492, 454))
        path.addQuadCurve(to: p(472.4, 530.8), control: p(483, 488))
        path.addQuadCurve(to: p(456, 610), control: p(461.9, 573.6))
        path.addQuadCurve(to: p(439.6, 625), control: p(452.9, 625))
        path.closeSubpath()
        return path
    }
}

/// Ask Life's button (22 Nov, his pick): Life's plain L in `on` ink on a cream disc, the one inverted control. A Liquid
/// Glass disc tinted `fg` (cream in dark). Listening turns the disc `ai` with a soft glow; working turns a thin `ai` arc
/// round the outside. Standalone: state and tap come in, so it carries into any navigation unchanged.
struct AskLifeButton: View {
    var size: CGFloat = 52
    var isListening = false
    var isWorking = false
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            LifeL().fill(Palette.on).frame(width: size * 0.3, height: size * 0.38)
                .frame(width: size, height: size)
                .glassEffect(.regular.tint(isListening ? Palette.ai : Palette.fg).interactive(), in: .circle)
                .shadow(color: Palette.ai.opacity(isListening ? 0.6 : 0), radius: 14)
                .overlay { if isWorking && !isListening { WorkingArc(size: size, isStill: reduceMotion) } }
        }
        .buttonStyle(.plain)
        .animation(Motion.standard, value: isListening)
        .animation(Motion.standard, value: isWorking)
        .accessibilityLabel("Ask Life")
        .accessibilityIdentifier("tell.life")
    }
}

/// A thin `ai` arc turning round the outside of the disc.
private struct WorkingArc: View {
    let size: CGFloat
    let isStill: Bool
    @State private var turn = false

    var body: some View {
        Circle().trim(from: 0, to: 0.25).stroke(Palette.ai, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
            .frame(width: size + 8, height: size + 8)
            .rotationEffect(.degrees(turn ? 360 : 0))
            .onAppear {
                if !isStill { withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) { turn = true } }
            }
            .transition(.opacity)
    }
}

/// What he said, waiting for the Mac: the mark and "Your words · waiting", in a quiet capsule.
struct AskLifeWaitingPill: View {
    let words: String

    var body: some View {
        HStack(spacing: Metrics.Spacing.s) {
            AskLifeMark(size: 16, color: Palette.muted)
            Text("Your words · waiting").font(.small)
        }
        .foregroundStyle(Palette.muted).padding(.horizontal, Metrics.Spacing.m).frame(height: 32)
        .background(Color.fillTint, in: .capsule)
        .accessibilityLabel("Your words are waiting: \(words)")
    }
}

/// The room Ask Life stands in: the page with a faint `ai` glow behind the stage.
struct AskLifeRoom: View {
    var body: some View {
        ZStack {
            Palette.bg
            RadialGradient(colors: [Palette.ai.opacity(0.12), .clear], center: .center, startRadius: 0, endRadius: 280)
        }
        .ignoresSafeArea()
    }
}

/// An answer's words: Grotesk, large; in the Grotesk look their key words (marked `**`) are bold.
struct AskLifeHead: View {
    let words: String
    @AppStorage(AskLifeLook.key) private var look = AskLifeLook.lit

    var body: some View {
        Group {
            if look == .grotesk { bolded } else { Text(words.withoutMarks) }
        }
        .font(.askLifeAnswer).foregroundStyle(Palette.fg).fixedSize(horizontal: false, vertical: true)
    }

    /// Only the `**` marks are read: words are data, never Markdown (no links).
    private var bolded: Text {
        var out = AttributedString()
        for (index, part) in words.components(separatedBy: "**").enumerated() {
            var run = AttributedString(part)
            if !index.isMultiple(of: 2) { run.inlinePresentationIntent = .stronglyEmphasized }
            out += run
        }
        return Text(out)
    }
}

/// A quiet line under the words.
struct AskLifeNote: View {
    let words: String

    var body: some View { Text(words).font(.note).foregroundStyle(Palette.muted) }
}

/// The veil under Ask Life's strip: the soft edge made stronger, blurred and dimmed from the foot up, over the page and the
/// list and under the bar, so the page above stays in view and Ask Life does the work under it. Full screen it grows to
/// the top (the stage covers it there, so only the cross puts it away). In the strip a tap on it puts Ask Life away.
struct AskLifeVeil: View {
    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life

    var body: some View {
        if router.askLife != .away {
            // The strip's veil grows into the full screen's with the lift: blur and dim, and how far up it reaches.
            let lift = router.askLifeProgress
            GeometryReader { screen in
                let reach = 280 + (screen.size.height - 280) * lift
                Rectangle().fill(.ultraThinMaterial)
                    .overlay(Color.black.opacity(0.5 + 0.1 * lift))
                    .mask(
                        LinearGradient(
                            stops: [
                                .init(color: .clear, location: 0), .init(color: .black, location: 0.6 - 0.48 * lift),
                            ],
                            startPoint: .top, endPoint: .bottom)
                    )
                    .frame(height: reach).contentShape(.rect).onTapGesture {
                        withAnimation(Motion.standard) { router.putAwayAskLife(life.askLife) }
                    }
                    .frame(maxHeight: .infinity, alignment: .bottom)
            }
            .ignoresSafeArea()
            .transition(.opacity).accessibilityHidden(true)
        }
    }
}
