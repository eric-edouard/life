import SwiftUI
import UIKit

/// Named motion. Under Reduce Motion, apply these through `motion(_:value:)` so changes land without movement.
enum Motion {
    /// State changes in place: selection, a badge changing, the summary expanding.
    static let standard = Animation.smooth(duration: 0.3)
    /// Something arriving: the selection bar, a card appearing.
    static let rise = Animation.spring(duration: 0.35, bounce: 0.12)
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

/// `withAnimation` that changes at once under Reduce Motion, for changes made in an action rather than a view.
func withMotion<Result>(_ animation: Animation, _ body: () throws -> Result) rethrows -> Result {
    try withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : animation, body)
}
