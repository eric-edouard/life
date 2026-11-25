import SwiftUI

/// What the edge shows: at rest two soft lights turn over a faint ring; while he speaks they run faster; while Life
/// works the ring swells blue (`ai`); with no Mac to answer it stands still.
enum EdgeState { case rest, speaking, working, still }

/// The edge: a ring round the screen on every screen. It glides between states over about a second.
/// ponytail: brand.md's exception for borders, motion and colour is written in the same PR; the look is the owner's to restyle.
struct EdgeView: View {
    let state: EdgeState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var clock = EdgeClock()

    var body: some View {
        TimelineView(.animation(paused: reduceMotion || state == .still)) { context in
            let p = clock.step(to: context.date, state: state)
            ZStack {
                layers(p, width: 2.5)
                layers(p, width: 14).blur(radius: 14).opacity(0.7)
            }
        }
        .allowsHitTesting(false).ignoresSafeArea().accessibilityHidden(true)
    }

    private func layers(_ p: EdgeClock.Pose, width: CGFloat) -> some View {
        let ring = ContainerRelativeShape()
        return ZStack {
            ring.strokeBorder(Palette.fg.opacity(0.14 * (1 - p.blue)), lineWidth: width)
            ring.strokeBorder(light(p.a1, 1), lineWidth: width).opacity((1 - p.blue) * p.light)
            ring.strokeBorder(light(p.a2, 0.8), lineWidth: width).opacity((1 - p.blue) * p.light)
            ring.strokeBorder(Palette.ai.opacity(0.5 * p.blue), lineWidth: width)
            ring.strokeBorder(arc(p.a3), lineWidth: width).opacity(p.blue)
        }
    }

    private func light(_ angle: Double, _ strength: Double) -> AngularGradient {
        AngularGradient(
            stops: [
                .init(color: .clear, location: 0), .init(color: Palette.fg.opacity(strength), location: 0.15),
                .init(color: .clear, location: 0.33), .init(color: .clear, location: 1),
            ], center: .center, angle: .degrees(angle))
    }

    private func arc(_ angle: Double) -> AngularGradient {
        AngularGradient(
            stops: [
                .init(color: .clear, location: 0), .init(color: Palette.ai, location: 0.17),
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

    func step(to now: Date, state: EdgeState) -> Pose {
        let dt = min(now.timeIntervalSince(last ?? now), 0.1)
        last = now
        let (targetSpeed, blue, light): (Double, Double, Double) =
            switch state {
            case .rest: (1, 0, 0.9)
            case .speaking: (1.8, 0, 1)
            case .working: (2, 1, 0)
            case .still: (0, 0, 0.9)
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
