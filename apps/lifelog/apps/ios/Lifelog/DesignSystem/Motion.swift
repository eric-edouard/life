import SwiftUI

/// Named motion. Under Reduce Motion, apply these through `motion(_:value:)` so changes land without movement.
enum Motion {
    /// State changes in place: selection, a badge changing, the summary expanding.
    static let standard = Animation.smooth(duration: 0.3)
    /// Something arriving: the selection bar, a card appearing.
    static let rise = Animation.spring(duration: 0.35, bounce: 0.12)
    /// Something going: fades and moves 8 pt the way it came.
    static let leave = Animation.easeIn(duration: 0.2)
    /// A row or group that comes or goes: enters with `rise`, leaves with `leave`.
    static let appears = AnyTransition.asymmetric(
        insertion: .opacity.combined(with: .offset(y: -8)).animation(rise),
        removal: .opacity.combined(with: .offset(y: -8)).animation(leave))
    /// The transcript scrolling to follow the spoken passage.
    static let follow = Animation.timingCurve(0.2, 0.7, 0.2, 1, duration: 0.7)
    /// One breath of the lit lens.
    static let pulse: TimeInterval = 2.4
}

extension View {
    /// `animation(_:value:)` that becomes an instant change under Reduce Motion.
    func motion(_ animation: Animation, value: some Equatable) -> some View {
        modifier(ReduceMotionAnimation(animation: animation, value: value))
    }
}

private struct ReduceMotionAnimation<Value: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let animation: Animation
    let value: Value

    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : animation, value: value)
    }
}
