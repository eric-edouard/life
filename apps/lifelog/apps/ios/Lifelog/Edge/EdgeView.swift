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
/// brand.md's motion and colour exceptions (26 Nov 2026) name it as their home.
struct EdgeView: View {
    let state: EdgeState
    var aura = AuraSetting()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var clock = EdgeClock()

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let p = clock.step(
                to: context.date, state: state, speed: state == .still ? 0 : aura.value(.speed, in: state))
            let glow = aura.value(.glow, in: state)
            ZStack {
                layers(p, width: 2.5)
                layers(p, width: glow).blur(radius: glow).opacity(0.7)
                if state == .speaking {
                    // The pool of light by the field.
                    RadialGradient(
                        colors: [ink(.speaking).opacity(0.35 * aura.value(.voiceLight, in: .speaking)), .clear],
                        center: .bottom, startRadius: 0, endRadius: 220)
                }
            }
        }
        .allowsHitTesting(false).ignoresSafeArea().accessibilityHidden(true)
    }

    /// Cream moved toward the aura's colour by the state's colour knob.
    private func ink(_ state: EdgeState) -> Color {
        Palette.fg.mix(with: aura.tint, by: aura.value(.colour, in: state))
    }

    private func layers(_ p: EdgeClock.Pose, width: CGFloat) -> some View {
        let ring = ContainerRelativeShape()
        // No Mac: cream only, fainter than idle; blue belongs to Working alone.
        let bright = aura.value(.brightness, in: state) * (state == .still ? Metrics.Opacity.dim : 1)
        let calm = ink(state == .working ? .rest : state)
        return ZStack {
            ring.strokeBorder(calm.opacity(0.4 * bright * (1 - p.blue)), lineWidth: width)
            ring.strokeBorder(light(p.a1, bright * 2.8, calm), lineWidth: width).opacity((1 - p.blue) * p.light)
            ring.strokeBorder(light(p.a2, bright * 2.2, calm), lineWidth: width).opacity((1 - p.blue) * p.light)
            ring.strokeBorder(ink(.working).opacity(0.5 * p.blue), lineWidth: width)
            ring.strokeBorder(arc(p.a3, bright), lineWidth: width).opacity(p.blue)
        }
    }

    private func light(_ angle: Double, _ strength: Double, _ colour: Color) -> AngularGradient {
        AngularGradient(
            stops: [
                .init(color: .clear, location: 0), .init(color: colour.opacity(min(strength, 1)), location: 0.15),
                .init(color: .clear, location: 0.33), .init(color: .clear, location: 1),
            ], center: .center, angle: .degrees(angle))
    }

    private func arc(_ angle: Double, _ strength: Double) -> AngularGradient {
        AngularGradient(
            stops: [
                .init(color: .clear, location: 0), .init(color: ink(.working).opacity(strength), location: 0.17),
                .init(color: .clear, location: 0.38), .init(color: .clear, location: 1),
            ], center: .center, angle: .degrees(angle))
    }
}

/// The edge's motion over time: each parameter glides toward its state's value (about a second), and the lights'
/// angles add up their speed, so a change of state never jumps.
@MainActor final class EdgeClock {
    struct Pose { var a1, a2, a3, blue, light: Double }
    private var pose = Pose(a1: 0, a2: 120, a3: 240, blue: 0, light: 0.9)
    private var speed = 1.0
    private var last: Date?

    func step(to now: Date, state: EdgeState, speed targetSpeed: Double) -> Pose {
        let dt = min(now.timeIntervalSince(last ?? now), 0.1)
        last = now
        let (blue, light): (Double, Double) =
            switch state {
            case .rest, .still: (0, 0.9)
            case .speaking: (0, 1)
            case .working: (1, 0)
            }
        let k = min(dt, 1)
        speed += (targetSpeed - speed) * k
        pose.blue += (blue - pose.blue) * k
        pose.light += (light - pose.light) * k
        pose.a1 += dt * speed * 360 / 18
        pose.a2 -= dt * speed * 360 / 27
        pose.a3 += dt * speed * 360 / 5
        return pose
    }
}
