import SwiftUI

/// What the edge shows: at rest two soft lights turn over a faint ring; while he speaks they run faster; while Life
/// works the ring swells blue (`ai`); with no Mac to answer it stands still.
enum EdgeState { case rest, speaking, working, still }

/// The aura: the edge's colour and, for each state, how far each knob sits in its band (0 is the band's low end, 1 its
/// high). Life's main session changes it only through this setting, clamped by `AuraBands`.
struct AuraSetting: Equatable {
    /// An index into `choices`: Life blue (the default), cream, then the eight of `Palette.auraColours`.
    var colour = 0
    var knobs: [EdgeState: [AuraKnob: Double]] = AuraSetting.standard

    /// Today's look: cream at rest and when he speaks, blue when Life works.
    static let standard: [EdgeState: [AuraKnob: Double]] = [
        .rest: [.speed: 0.75, .brightness: 1, .glow: 0.5, .colour: 0],
        .speaking: [.speed: 0.25, .brightness: 0.5, .glow: 0.5, .colour: 0, .voiceLight: 0.5],
        .working: [.speed: 1, .brightness: 0.8, .glow: 0.5, .colour: 1],
    ]

    /// The aura's ten colours, as the settings offer them.
    static let choices: [(name: String, color: Color)] =
        [("Life blue", Palette.ai), ("cream", Palette.fg)] + Palette.auraColours

    var tint: Color { Self.choices[colour].color }

    /// A knob's value in its band's units; the idle colour never rises above You speak's.
    func value(_ knob: AuraKnob, in state: EdgeState) -> Double {
        let state = state == .still ? .rest : state
        guard let band = AuraBands.table[state]?[knob] else { return 0 }
        var at = knobs[state]?[knob] ?? 0
        if state == .rest, knob == .colour {
            let speaks = AuraBands.table[.speaking]?[.colour].map {
                $0.lo + ($0.hi - $0.lo) * (knobs[.speaking]?[.colour] ?? 0)
            }
            return min(band.lo + (band.hi - band.lo) * at, speaks ?? 1)
        }
        at = min(max(at, 0), 1)
        return band.lo + (band.hi - band.lo) * at
    }
}

enum AuraKnob: CaseIterable { case speed, brightness, glow, colour, voiceLight }

/// Each knob's band for each state, in one table (the design system page's "Knobs and bands"): idle's speed,
/// brightness and colour stay below the other states', so idle never looks like work.
enum AuraBands {
    static let table: [EdgeState: [AuraKnob: (lo: Double, hi: Double)]] = [
        .rest: [.speed: (0.4, 1.2), .brightness: (0.10, 0.35), .glow: (6, 13), .colour: (0, 0.30)],
        .speaking: [
            .speed: (1.5, 2.8), .brightness: (0.40, 0.60), .glow: (12, 20), .colour: (0, 0.50),
            .voiceLight: (0.5, 1),
        ],
        .working: [.speed: (0.8, 2), .brightness: (0.65, 1), .glow: (16, 28), .colour: (0.70, 1)],
    ]
}

/// The edge: a ring round the screen on every screen. It glides between states over about a second.
/// brand.md's motion and colour exceptions (26 Nov 2026) name it as their home. The app draws nothing per frame: the
/// lights are conic gradients the render server spins, under a ring mask drawn once (the glow's blurred once per change).
struct EdgeView: View {
    let state: EdgeState
    var aura = AuraSetting()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        AuraLayers(look: look)
            .allowsHitTesting(false).ignoresSafeArea().accessibilityHidden(true)
    }

    /// Cream moved toward the aura's colour by the state's colour knob.
    private func ink(_ state: EdgeState) -> UIColor {
        UIColor(Palette.fg.mix(with: aura.tint, by: aura.value(.colour, in: state)))
    }

    private var look: AuraLook {
        // No Mac: cream only, fainter than idle; blue belongs to Working alone.
        AuraLook(
            calm: ink(state == .working ? .rest : state), work: ink(.working),
            bright: aura.value(.brightness, in: state) * (state == .still ? Metrics.Opacity.dim : 1),
            glow: aura.value(.glow, in: state), speed: state == .still ? 0 : aura.value(.speed, in: state),
            blue: state == .working ? 1 : 0, light: state == .speaking ? 1 : state == .working ? 0 : 0.9,
            pool: state == .speaking ? 0.35 * aura.value(.voiceLight, in: .speaking) : 0,
            poolColour: ink(.speaking), running: !reduceMotion && scenePhase == .active)
    }
}

/// Everything the layers need, worked out by `EdgeView`.
struct AuraLook: Equatable {
    var calm, work: UIColor
    var bright, glow, speed, blue, light, pool: Double
    var poolColour: UIColor
    var running: Bool
}

private struct AuraLayers: UIViewRepresentable {
    let look: AuraLook
    func makeUIView(context: Context) -> AuraLayerView { AuraLayerView() }
    func updateUIView(_ view: AuraLayerView, context: Context) { view.apply(look) }
}

/// One ring (the line, or the glow): a still calm ring, two lights turning opposite ways, a still working ring and the
/// working arc, all under one ring mask. Rest shows the first three, Working the last two (`blue`).
private final class AuraBand {
    let holder = CALayer(), calm = CALayer(), work = CALayer()
    let light1 = CAGradientLayer(), light2 = CAGradientLayer(), arc = CAGradientLayer()
    var spins: [CAGradientLayer] { [light1, light2, arc] }
    private var spinSpeed: Float?

    init(bounds: CGRect) {
        holder.frame = bounds
        // Turns per second at speed 1: the lights' and the arc's old periods, 18 s, 27 s (backwards) and 5 s.
        for (spin, from, period) in [(light1, 0.0, 18.0), (light2, 120, -27), (arc, 240, 5)] {
            let side = hypot(bounds.width, bounds.height)
            spin.type = .conic
            spin.bounds = CGRect(x: 0, y: 0, width: side, height: side)
            spin.position = CGPoint(x: bounds.midX, y: bounds.midY)
            spin.startPoint = CGPoint(x: 0.5, y: 0.5)
            spin.endPoint = CGPoint(x: 0.5, y: 0)
            // The gradient starts at 12 o'clock, SwiftUI's angle at 3.
            let start = (from + 90) * .pi / 180
            let turn = CABasicAnimation(keyPath: "transform.rotation.z")
            turn.fromValue = start
            turn.toValue = start + (period < 0 ? -2 : 2) * .pi
            turn.duration = abs(period)
            turn.repeatCount = .infinity
            turn.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
            spin.add(turn, forKey: "turn")
        }
        for layer in [calm, light1, light2, work, arc] { holder.addSublayer(layer) }
        calm.frame = bounds
        work.frame = bounds
    }

    /// The gradient: clear, the colour at `peak`, clear at `end`, clear again.
    private func fill(_ spin: CAGradientLayer, _ colour: UIColor, peak: NSNumber, end: NSNumber) {
        spin.colors = [
            colour.withAlphaComponent(0), colour, colour.withAlphaComponent(0), colour.withAlphaComponent(0),
        ]
        .map(\.cgColor)
        spin.locations = [0, peak, end, 1]
    }

    func apply(_ look: AuraLook, glowLayer: Bool) {
        calm.backgroundColor = look.calm.withAlphaComponent(0.4 * look.bright).cgColor
        calm.opacity = Float(1 - look.blue)
        fill(light1, look.calm.withAlphaComponent(min(look.bright * 2.8, 1)), peak: 0.15, end: 0.33)
        fill(light2, look.calm.withAlphaComponent(min(look.bright * 2.2, 1)), peak: 0.15, end: 0.33)
        light1.opacity = Float((1 - look.blue) * look.light)
        light2.opacity = light1.opacity
        work.backgroundColor = look.work.withAlphaComponent(0.5).cgColor
        work.opacity = Float(look.blue)
        fill(arc, look.work.withAlphaComponent(min(look.bright, 1)), peak: 0.17, end: 0.38)
        arc.opacity = Float(look.blue)
        holder.opacity = glowLayer ? 0.7 : 1
    }

    /// A step in speed, not a ramp; each light keeps its angle (re-anchored at now), and speed 0 holds it.
    func spin(at speed: Float) {
        guard speed != spinSpeed else { return }
        spinSpeed = speed
        let now = CACurrentMediaTime()
        for layer in spins {
            let at = layer.convertTime(now, from: nil)
            layer.speed = speed
            layer.timeOffset = at
            layer.beginTime = now
        }
    }
}

private final class AuraLayerView: UIView {
    private var bands: [(band: AuraBand, mask: CALayer)] = []
    private let pool = CAGradientLayer()
    private var look: AuraLook?
    private var laidOut = CGRect.zero
    private static let blurred = CIContext()

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds != laidOut, bounds.width > 0 else { return }
        laidOut = bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.sublayers = nil
        bands = [AuraBand(bounds: bounds), AuraBand(bounds: bounds)].map { ($0, CALayer()) }
        for (band, mask) in bands {
            mask.frame = bounds
            band.holder.mask = mask
            layer.addSublayer(band.holder)
        }
        pool.type = .radial
        pool.frame = bounds
        pool.startPoint = CGPoint(x: 0.5, y: 1)
        pool.endPoint = CGPoint(x: 0.5 + 220 / bounds.width, y: 1 + 220 / bounds.height)
        pool.locations = [0, 1]
        layer.addSublayer(pool)
        CATransaction.commit()
        if let look { apply(look, first: true) }
    }

    func apply(_ look: AuraLook) { apply(look, first: self.look == nil) }

    private func apply(_ look: AuraLook, first: Bool) {
        let glowChanged = look.glow != self.look?.glow
        self.look = look
        guard let (line, glow) = bands.first.map({ ($0, bands[1]) }) else { return }
        CATransaction.begin()
        // The lights and colours glide over about a second, as the old clock did; the first look just appears.
        CATransaction.setAnimationDuration(1)
        CATransaction.setDisableActions(first)
        line.band.apply(look, glowLayer: false)
        glow.band.apply(look, glowLayer: true)
        pool.colors = [look.poolColour.withAlphaComponent(look.pool), look.poolColour.withAlphaComponent(0)]
            .map(\.cgColor)
        CATransaction.commit()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if first { line.mask.contents = ring(width: 2.5, blur: 0) }
        if first || glowChanged { glow.mask.contents = ring(width: look.glow, blur: look.glow) }
        CATransaction.commit()
        let speed = Float(look.running ? look.speed : 0)
        line.band.spin(at: speed)
        glow.band.spin(at: speed)
    }

    /// The screen's rounded rectangle as a stroke, blurred (a gaussian of the glow's width); drawn
    /// once per glow change, never per frame.
    private func ring(width: CGFloat, blur: CGFloat) -> CGImage? {
        let radius = Metrics.Radius.screen
        let sharp = UIGraphicsImageRenderer(bounds: bounds).image { _ in
            UIColor.white.setStroke()
            let path = UIBezierPath(
                roundedRect: bounds.insetBy(dx: width / 2, dy: width / 2), cornerRadius: radius - width / 2)
            path.lineWidth = width
            path.stroke()
        }
        guard blur > 0, let input = CIImage(image: sharp) else { return sharp.cgImage }
        let out = input.applyingGaussianBlur(sigma: blur).cropped(to: input.extent)
        return Self.blurred.createCGImage(out, from: input.extent) ?? sharp.cgImage
    }
}
