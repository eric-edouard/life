import SwiftUI

/// Named motion. Under Reduce Motion, apply these through `motion(_:value:)` so changes land without movement.
enum Motion {
    /// State changes in place: selection, a badge changing, the summary expanding.
    static let standard = Animation.smooth(duration: 0.3)
    /// Something arriving: the selection bar, a card appearing.
    static let rise = Animation.spring(duration: 0.35, bounce: 0.12)
    /// Something going: fades and moves 8 pt the way it came.
    static let leave = Animation.easeIn(duration: 0.2)
    /// A row or group that comes or goes: enters with `rise`, leaves with `leave`; `.identity` under Reduce Motion.
    static let appears = AnyTransition.asymmetric(
        insertion: .opacity.combined(with: .offset(y: -8)).animation(rise),
        removal: .opacity.combined(with: .offset(y: -8)).animation(leave))
    /// An ask he answered: slides off to the leading edge as the next comes in from the trailing one, and back from the
    /// leading edge on Undo. Carries no animation: the pager's change (`rise`) moves both pages together.
    static let passes = AnyTransition.move(edge: .leading)
    /// His tap's result taking the ask's place, and each new state of it (sending, sent, not sent): what was there fades
    /// (`leave`), then the result rises 12 pt into place (`rise`), so the two never show over each other.
    static let result = AnyTransition.asymmetric(insertion: resultRises, removal: .opacity.animation(leave))
    /// A result that worked: rises as `result` does, and goes the way an answered ask goes (`passes`) as the next comes in.
    static let resultDone = AnyTransition.asymmetric(insertion: resultRises, removal: passes)
    private static let resultRises = AnyTransition.opacity.combined(with: .offset(y: 12)).animation(rise.delay(0.2))
    /// The ask coming back after a result: in from the trailing edge, as the next ask does; it fades as the result rises.
    static let ask = AnyTransition.asymmetric(insertion: .move(edge: .trailing), removal: .opacity.animation(leave))
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

private struct Appears: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let transition: AnyTransition

    func body(content: Content) -> some View {
        content.transition(reduceMotion ? .opacity : transition)
    }
}

extension View {
    /// How a view comes and goes (`Motion.appears` for a row or group), a cross-fade under Reduce Motion: the one way to
    /// give a view a transition.
    func appears(_ transition: AnyTransition = Motion.appears) -> some View {
        modifier(Appears(transition: transition))
    }

    /// The source a sheet or a pushed page zooms out of and back into (the system's zoom); nothing without an id or a
    /// namespace.
    @ViewBuilder func zoomSource<ID: Hashable>(_ id: ID?, in namespace: Namespace.ID?) -> some View {
        if let id, let namespace { matchedTransitionSource(id: id, in: namespace) } else { self }
    }

    /// A sheet or pushed page that zooms out of its source (`zoomSource`), else the system's own transition. The system
    /// cross-fades it under Reduce Motion.
    @ViewBuilder func zooms(from id: some Hashable, in namespace: Namespace.ID?) -> some View {
        if let namespace { navigationTransition(.zoom(sourceID: id, in: namespace)) } else { self }
    }
}
