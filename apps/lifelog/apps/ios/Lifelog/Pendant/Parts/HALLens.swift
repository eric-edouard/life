import SwiftUI

/// The Lens layout's lamp: HAL 9000's eye as a record light (docs/design.md, Pendant).
/// Flat glass lit from behind, faint inner rings, a dark bezel and a bloom that spills onto the page. Lit only by a
/// confirmed recording and brighter while the Pendant hears sound; an ember when paused; dark glass in a dashed ring
/// when the state is unknown. A thin ring fills around it while catching up. Decorative: the word under it speaks.
///
/// It only moves while it hears sound: the rings shimmer and the glow breathes, at most 30 frames a second, never off
/// screen, while scrolling, in the background or under Reduce Motion (`OnScreenTimeline`). Any other change eases once,
/// then nothing redraws. The canvas draws off the main thread: drawn on it, each frame cost a scroll frame.
struct HALLens: View {
    enum Light: Equatable {
        case lit
        case ember
        case dark
    }

    let light: Light
    var hearing = false
    /// A catch-up's progress, 0...1; `nil` draws no ring.
    var progress: Double?
    var diameter: CGFloat = 196

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let moving = light == .lit && hearing && !reduceMotion
        OnScreenTimeline(minimumInterval: 1.0 / 30, paused: !moving) { date in
            LensCanvas(
                glow: light == .lit ? (hearing ? 1 : Self.quietGlow) : 0, ember: light == .ember ? 1 : 0,
                dash: light == .dark ? 1 : 0, ring: progress == nil ? 0 : 1, progress: progress ?? 0,
                diameter: diameter, time: moving ? date.timeIntervalSinceReferenceDate : nil)
        }
        .frame(width: diameter, height: diameter)
        .motion(.smooth(duration: 0.9), value: light)
        .motion(.smooth(duration: 1.4), value: hearing)
        .motion(Motion.standard, value: progress)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// Lit but quiet: a steady glow. Hearing sound takes it to 1.
    static let quietGlow = 0.55
}

/// One frame of the lens. Every value eases, so a change of state fades instead of jumping.
@Animatable
private struct LensCanvas: View {
    /// 0 out, `HALLens.quietGlow` lit and quiet, 1 hearing.
    var glow: Double
    var ember: Double
    var dash: Double
    var ring: Double
    var progress: Double
    @AnimatableIgnored var diameter: CGFloat
    /// Seconds, while hearing sound; `nil` is a still frame.
    @AnimatableIgnored var time: Double?

    var body: some View {
        // Bigger than the lens so the bloom can spill onto the page.
        Canvas(rendersAsynchronously: true) { context, size in draw(in: &context, size: size) }
            .frame(width: diameter * 1.9, height: diameter * 1.9)
    }

    private func draw(in context: inout GraphicsContext, size: CGSize) {
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let radius = diameter / 2
        let bezel = radius * 1.17
        // While hearing, the glow breathes a little on the live dot's beat.
        let breath = time.map { 0.5 + 0.5 * sin($0 * 2 * .pi / Motion.pulse) } ?? 1
        let intensity = glow * (0.93 + 0.07 * breath)
        // How lit the glass is, 0...1: a fade out or in passes through it.
        let lit = min(1, glow / HALLens.quietGlow)
        func circle(_ r: CGFloat) -> Path {
            Path(ellipseIn: CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2))
        }
        func radial(_ stops: [(Color, Double)], from start: CGFloat = 0, to end: CGFloat, at point: CGPoint? = nil)
            -> GraphicsContext.Shading
        {
            .radialGradient(
                Gradient(stops: stops.map { Gradient.Stop(color: $0.0, location: $0.1) }), center: point ?? center,
                startRadius: start, endRadius: end)
        }

        // 1. Bloom, behind everything: light leaving the lens.
        if lit > 0 {
            context.fill(
                Path(CGRect(origin: .zero, size: size)),
                with: radial(
                    [
                        (tone(0xFF2C24, 0.34 * intensity), 0), (tone(0xBE101A, 0.13 * intensity), 0.35),
                        (tone(0x78000A, 0), 1),
                    ], from: radius * 0.7, to: size.width / 2))
        }

        // 2. The bezel: dark metal lit from above (the metal, never the glass), with a thin edge.
        context.fill(
            circle(bezel),
            with: .linearGradient(
                Gradient(stops: [
                    .init(color: tone(0x3D3936), location: 0), .init(color: tone(0x1B1918), location: 0.45),
                    .init(color: tone(0x0C0B0A), location: 1),
                ]), startPoint: CGPoint(x: center.x, y: center.y - bezel),
                endPoint: CGPoint(x: center.x, y: center.y + bezel)))
        context.stroke(
            circle(bezel - 0.5),
            with: .linearGradient(
                Gradient(stops: [
                    .init(color: .white.opacity(0.22), location: 0), .init(color: .white.opacity(0.03), location: 0.5),
                    .init(color: .white.opacity(0.08), location: 1),
                ]), startPoint: CGPoint(x: center.x, y: center.y - bezel),
                endPoint: CGPoint(x: center.x, y: center.y + bezel)), lineWidth: 1)
        context.fill(circle(radius * 1.025), with: .color(tone(0x030202)))

        // 3. The glass, flat and lit from behind: light falls off from the center, never shaded like a ball.
        var glass = context
        glass.clip(to: circle(radius))
        glass.fill(
            circle(radius), with: radial([(tone(0x3C0B0E), 0), (tone(0x1F0508), 0.6), (tone(0x0B0203), 1)], to: radius))
        if dash > 0 {
            glass.fill(
                circle(radius), with: radial([(tone(0x161414, dash), 0), (tone(0x070606, dash), 1)], to: radius))
        }
        if lit > 0 {
            let core = 0.05 + 0.05 * max(0, (glow - HALLens.quietGlow) / (1 - HALLens.quietGlow))
            glass.opacity = lit * (0.38 + 0.62 * intensity)
            glass.fill(
                circle(radius),
                with: radial(
                    [
                        (tone(0xFFF7E8), 0), (tone(0xFFCE96), core), (tone(0xFF7446), core + 0.09),
                        (tone(0xE82622), 0.3), (tone(0x920A14), 0.56), (tone(0x3A0308), 0.84), (tone(0x100103), 1),
                    ], to: radius))
            glass.opacity = 1
        }
        if ember > 0 {
            // Out, with a little warmth left.
            glass.fill(
                circle(radius),
                with: radial([(tone(0xFF4632, 0.16 * ember), 0), (tone(0xFF4632, 0), 1)], to: radius * 0.55))
        }

        // 4. The fisheye's inner elements: faint concentric rings, shimmering while it hears.
        for (index, scale) in [0.17, 0.29, 0.44, 0.6, 0.76, 0.91].enumerated() {
            let step = Double(index)
            let shimmer = 0.07 + 0.05 * sin((time ?? 0) * 0.8 + step * 1.7)
            let width: CGFloat = index > 3 ? 1.1 : 0.8
            glass.stroke(
                circle(radius * scale), with: .color(Palette.textPrimary.opacity(0.045 * (1 - lit))), lineWidth: width)
            glass.stroke(
                circle(radius * scale),
                with: .color(
                    Color(red: 1, green: (130 + 12 * step) / 255, blue: (100 + 6 * step) / 255)
                        .opacity(shimmer * (0.7 + 0.3 * intensity) * lit)), lineWidth: width)
        }

        // 5. A window reflected on the glass: soft arcs upper left and lower right, and a pinpoint.
        for (from, to, at, width, opacity) in [
            (1.1, 1.42, 0.72, 0.2, 0.035), (1.14, 1.36, 0.78, 0.06, 0.09), (0.16, 0.3, 0.8, 0.05, 0.035),
        ] {
            var arc = Path()
            arc.addRelativeArc(
                center: center, radius: radius * at, startAngle: .radians(from * .pi),
                delta: .radians((to - from) * .pi))
            glass.stroke(
                arc, with: .color(.white.opacity(opacity)),
                style: StrokeStyle(lineWidth: radius * width, lineCap: .round))
        }
        let glint = CGPoint(x: center.x - radius * 0.5, y: center.y - radius * 0.52)
        glass.fill(
            circle(radius),
            with: radial([(.white.opacity(0.4), 0), (.white.opacity(0), 1)], to: radius * 0.07, at: glint))

        // 6. Outside the bezel: the catch-up ring, or the dashed ring of an unknown state.
        let outer = circle(bezel + 5)
        if ring > 0 {
            context.stroke(outer, with: .color(Palette.textPrimary.opacity(0.1 * ring)), lineWidth: 2.5)
            var filled = Path()
            filled.addRelativeArc(
                center: center, radius: bezel + 5, startAngle: .degrees(-90),
                delta: .degrees(360 * min(max(progress, 0), 1)))
            context.stroke(
                filled, with: .color(Palette.textPrimary.opacity(ring)),
                style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
        }
        if dash > 0 {
            context.stroke(
                outer, with: .color(Palette.textPrimary.opacity(0.28 * dash)),
                style: StrokeStyle(lineWidth: 1.2, dash: [3, 3]))
        }
    }

    /// The lens's own light and metal, not the app's palette (like the Pendant's LED colors in the light guide).
    private func tone(_ hex: UInt32, _ opacity: Double = 1) -> Color {
        Color(
            red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255
        )
        .opacity(opacity)
    }
}
