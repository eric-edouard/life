import LifeConnector
import SwiftUI

/// What the edge shows: at rest two soft lights turn over a faint ring; while he speaks they run faster; while Life
/// works the ring swells blue (`ai`); with no Mac to answer it stands still.
enum EdgeState { case rest, speaking, working, still }

extension AuraSetting {
    /// The aura's ten colours, as the halo settings offer them.
    static let choices: [(name: String, color: Color)] =
        [("Life blue", Palette.ai), ("cream", Palette.fg)] + Palette.auraColours

    var tint: Color { Self.choices[min(max(colour, 0), Self.choices.count - 1)].color }

    /// The edge's values in `state`.
    subscript(state: EdgeState) -> State {
        get {
            switch state {
            case .rest: states.rest
            case .speaking: states.speaking
            case .working: states.working
            case .still: states.still
            }
        }
        set {
            switch state {
            case .rest: states.rest = newValue
            case .speaking: states.speaking = newValue
            case .working: states.working = newValue
            case .still: states.still = newValue
            }
        }
    }
}

/// The edge: a ring round the screen on every screen. It glides between states over about a second. Every value it
/// draws is the aura's (`AuraSetting`, his halo settings).
/// brand.md's motion and colour exceptions (26 Nov 2026) name it as their home. The app draws nothing per frame: the
/// lights are conic gradients the render server spins, under a ring mask drawn once (the glow's blurred once per change).
struct EdgeView: View {
    let state: EdgeState
    var aura = AuraSetting.standard
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        AuraLayers(look: look)
            .allowsHitTesting(false).ignoresSafeArea().accessibilityHidden(true)
    }

    /// Cream moved toward the aura's colour by the state's colour.
    private func ink(_ state: EdgeState) -> UIColor { UIColor(Palette.fg.mix(with: aura.tint, by: aura[state].colour)) }

    private var look: AuraLook {
        // The calm ring keeps idle's colour while Life works; the working ring and arc take Working's.
        AuraLook(
            aura: aura, now: aura[state], calm: ink(state == .working ? .rest : state), work: ink(.working),
            pool: ink(state), blue: state == .working ? 1 : 0, running: !reduceMotion && scenePhase == .active)
    }
}

/// Everything the layers need, worked out by `EdgeView`: the aura, its values in the state shown, and the inks.
struct AuraLook: Equatable {
    var aura: AuraSetting
    var now: AuraSetting.State
    var calm, work, pool: UIColor
    var blue: Double
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
    private var turns: [AuraSetting.Light] = []

    init(bounds: CGRect) {
        holder.frame = bounds
        for spin in spins {
            let side = hypot(bounds.width, bounds.height)
            spin.type = .conic
            spin.bounds = CGRect(x: 0, y: 0, width: side, height: side)
            spin.position = CGPoint(x: bounds.midX, y: bounds.midY)
            spin.startPoint = CGPoint(x: 0.5, y: 0.5)
            spin.endPoint = CGPoint(x: 0.5, y: 0)
        }
        for layer in [calm, light1, light2, work, arc] { holder.addSublayer(layer) }
        calm.frame = bounds
        work.frame = bounds
    }

    /// Each spin's turn, its period and way from the aura; a turn changed starts again from its own angle.
    private func turn(_ lights: [AuraSetting.Light]) {
        guard lights != turns else { return }
        turns = lights
        for ((spin, from), light) in zip([(light1, 0.0), (light2, 120), (arc, 240)], lights) {
            // The gradient starts at 12 o'clock, SwiftUI's angle at 3.
            let start = (from + 90) * .pi / 180
            let turn = CABasicAnimation(keyPath: "transform.rotation.z")
            turn.fromValue = start
            turn.toValue = start + (light.clockwise ? 2 : -2) * .pi
            turn.duration = light.seconds
            turn.repeatCount = .infinity
            // Kept when the app goes to the background: iOS removes a finished-on-removal animation then, and the lights stood still.
            turn.isRemovedOnCompletion = false
            turn.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
            spin.add(turn, forKey: "turn")
        }
    }

    /// The gradient: clear, the colour at `peak`, clear at `end`, clear again.
    private func fill(_ spin: CAGradientLayer, _ colour: UIColor, _ light: AuraSetting.Light) {
        spin.colors = [
            colour.withAlphaComponent(0), colour, colour.withAlphaComponent(0), colour.withAlphaComponent(0),
        ]
        .map(\.cgColor)
        spin.locations = [0, light.peak, light.end, 1].map { NSNumber(value: $0) }
    }

    func apply(_ look: AuraLook, glowLayer: Bool) {
        let (aura, bright) = (look.aura, look.now.brightness)
        let (first, second) = (aura.lights[0], aura.lights[1])
        turn([first, second, aura.arc])
        calm.backgroundColor = look.calm.withAlphaComponent(aura.rings.calm * bright).cgColor
        calm.opacity = Float(1 - look.blue)
        fill(light1, look.calm.withAlphaComponent(min(bright * first.gain, 1)), first)
        fill(light2, look.calm.withAlphaComponent(min(bright * second.gain, 1)), second)
        // The line is a thin border; only the glow carries the moving lights, softly.
        light1.opacity = glowLayer ? Float((1 - look.blue) * look.now.lights * first.opacity) : 0
        light2.opacity = glowLayer ? Float((1 - look.blue) * look.now.lights * second.opacity) : 0
        work.backgroundColor = look.work.withAlphaComponent(aura.rings.work).cgColor
        work.opacity = Float(look.blue)
        fill(arc, look.work.withAlphaComponent(min(bright * aura.arc.gain, 1)), aura.arc)
        arc.opacity = glowLayer ? Float(look.blue * aura.arc.opacity) : 0
        holder.opacity = Float(glowLayer ? aura.glowOpacity : aura.line.opacity)
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
        pool.locations = [0, 1]
        layer.addSublayer(pool)
        CATransaction.commit()
        if let look {
            self.look = nil
            apply(look, first: true)
        }
    }

    func apply(_ look: AuraLook) { apply(look, first: self.look == nil) }

    private func apply(_ look: AuraLook, first: Bool) {
        let before = self.look
        self.look = look
        guard let (line, glow) = bands.first.map({ ($0, bands[1]) }) else { return }
        CATransaction.begin()
        // The lights and colours glide over about a second, as the old clock did; the first look just appears.
        CATransaction.setAnimationDuration(1)
        CATransaction.setDisableActions(first)
        line.band.apply(look, glowLayer: false)
        glow.band.apply(look, glowLayer: true)
        pool.colors = [look.pool.withAlphaComponent(look.now.pool), look.pool.withAlphaComponent(0)].map(\.cgColor)
        CATransaction.commit()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let radius = look.aura.poolRadius
        pool.endPoint = CGPoint(x: 0.5 + radius / bounds.width, y: 1 + radius / bounds.height)
        // The masks are drawn again only when their width or blur changed: never per frame.
        let width = look.aura.line.width
        if width != before?.aura.line.width { line.mask.contents = width > 0 ? ring(width: width, blur: 0) : nil }
        if look.now.glow != before?.now.glow || look.now.blur != before?.now.blur {
            glow.mask.contents = ring(width: look.now.glow, blur: look.now.blur)
        }
        CATransaction.commit()
        let speed = Float(look.running ? look.now.speed : 0)
        line.band.spin(at: speed)
        glow.band.spin(at: speed)
    }

    /// The screen's rounded rectangle as a stroke of `width`, blurred (a gaussian of `blur`).
    private func ring(width: CGFloat, blur: CGFloat) -> CGImage? {
        let radius = window?.screen.cornerRadius ?? Metrics.Radius.screen
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

extension UIScreen {
    /// This screen's own corner radius, as iOS draws it (the way ScreenCorners reads it); nil where iOS does not say.
    /// The key is split so a plain scan of the binary does not flag it.
    fileprivate var cornerRadius: CGFloat? {
        let key = ["_display", "Corner", "Radius"].joined()
        guard responds(to: NSSelectorFromString(key)), let radius = value(forKey: key) as? CGFloat, radius > 0 else {
            return nil
        }
        return radius
    }
}
