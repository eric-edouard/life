import SwiftUI

/// Named motion. Under Reduce Motion, apply these through `motion(_:value:)` so changes land without movement.
enum Motion {
    /// State changes in place: selection, a badge changing, the summary expanding.
    static let standard = Animation.smooth(duration: 0.3)
    /// Something arriving: the selection bar, a card appearing.
    static let rise = Animation.spring(duration: 0.35, bounce: 0.12)
    /// Something going: fades and moves 8 pt the way it came.
    static let leave = Animation.easeIn(duration: leaving)
    private static let leaving: TimeInterval = 0.2
    /// A row or group that comes or goes: enters with `rise`, leaves with `leave`; `.identity` under Reduce Motion.
    static let appears = AnyTransition.asymmetric(
        insertion: .opacity.combined(with: .offset(y: -8)).animation(rise),
        removal: .opacity.combined(with: .offset(y: -8)).animation(leave))
    /// An ask he answered: slides off to the leading edge as the next comes in from the trailing one, and back from the
    /// leading edge on Undo. Carries no animation: the pager's change (`rise`) moves both pages together.
    static let passes = AnyTransition.move(edge: .leading)
    /// His tap's result taking the ask's place: it rises 12 pt once the ask has faded (`leave`), so the two never show
    /// over each other; it goes the way an answered ask goes (`passes`) as the next comes in.
    static let result = AnyTransition.asymmetric(insertion: resultRises, removal: passes)
    /// A new state of the result (sending, sent, not sent): the last one fades (`leave`), then the new one rises.
    static let resultFace = AnyTransition.asymmetric(insertion: resultRises, removal: .opacity.animation(leave))
    private static let resultRises = AnyTransition.opacity.combined(with: .offset(y: 12)).animation(
        rise.delay(leaving))
    /// The ask coming back after a result: in from the trailing edge, as the next ask does; it fades as the result rises.
    static let ask = AnyTransition.asymmetric(insertion: .move(edge: .trailing), removal: .opacity.animation(leave))
    /// A cross-fade (`standard`), carrying its own animation: what every transition becomes under Reduce Motion, where
    /// `motion(_:value:)` gives none, and the way a read's faces change.
    static let fade = AnyTransition.opacity.animation(standard)
    /// Something landing in the thread (a row, one of Life's blocks): rises 8 pt from blur, as the prototype's `rise`;
    /// leaves with `leave`. A cross-fade under Reduce Motion (`appears`).
    static let arrives = AnyTransition.modifier(
        active: Blurred(amount: 1), identity: Blurred(amount: 0)
    ).animation(rise)
    /// Life's words inking in: a word's fade, blur and 3 pt rise take `inkWord`, and `inkRate` apart they follow each
    /// other; `inkOverlap` words are on their way at once.
    static let inkWord: TimeInterval = 0.38
    static let inkRate: TimeInterval = 0.045
    static let inkOverlap = 8.0
    /// A row's wash on a change of state: it lights and fades, so the eye finds what changed.
    static let wash = Animation.easeOut(duration: 1.4)
    static let washLevel = 0.1
    /// One sweep of the thinking line's shimmer.
    static let shimmer: TimeInterval = 2
    /// A new line of the live log sliding in from the top.
    static let logLine = Animation.spring(duration: 0.25)
    /// The transcript scrolling to follow the spoken passage.
    static let follow = Animation.timingCurve(0.2, 0.7, 0.2, 1, duration: 0.7)
    /// One breath of the lit lens.
    static let pulse: TimeInterval = 2.4
    /// The lit lens breathing: half a pulse each way, forever.
    static let breath = Animation.easeInOut(duration: pulse / 2).repeatForever()
    /// The dictation thumb: following the finger while it is down, home with a little spring, growing when held, the
    /// armed state arriving, the mark flying off, and the level bars moving.
    static let thumbFollows = Animation.interactiveSpring(duration: 0.2)
    static let thumbHome = Animation.spring(duration: 0.4, bounce: 0.25)
    static let thumbGrows = Animation.spring(duration: 0.3, bounce: 0.2)
    static let armed = Animation.easeOut(duration: 0.15)
    static let flightOff = Animation.spring(duration: 0.22, bounce: 0)
    static let level = Animation.easeOut(duration: 0.12)
    /// A drafted part's shadow going once it is sent.
    static let undrafted = Animation.easeOut(duration: 0.2)
}

extension View {
    /// `animation(_:value:)` that becomes an instant change under Reduce Motion.
    func motion(_ animation: Animation?, value: some Equatable) -> some View {
        modifier(ReduceMotionAnimation(animation: animation, value: value))
    }
}

private struct ReduceMotionAnimation<Value: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let animation: Animation?
    let value: Value

    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : animation, value: value)
    }
}

private struct Appears: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let transition: AnyTransition

    func body(content: Content) -> some View {
        content.transition(reduceMotion ? Motion.fade : transition)
    }
}

extension View {
    /// How a view comes and goes (`Motion.appears` for a row or group), a cross-fade under Reduce Motion: the one way to
    /// give a view a transition.
    func appears(_ transition: AnyTransition = Motion.appears) -> some View {
        modifier(Appears(transition: transition))
    }

    /// A view whose face changes with `face` (a sheet's phase, an action's state): the old face fades out as the new
    /// fades in, as a read's faces do; the same face with new values changes in place.
    func faces(_ face: some Hashable) -> some View {
        ZStack(alignment: .topLeading) { appears(Motion.fade).id(face) }
            .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// The source a sheet or a pushed page zooms out of and back into (the system's zoom); nothing without an id or a
    /// namespace.
    @ViewBuilder func zoomSource<ID: Hashable>(_ id: ID?, in namespace: Namespace.ID?) -> some View {
        if let id, let namespace { matchedTransitionSource(id: id, in: namespace) } else { self }
    }

    /// A sheet or pushed page that zooms out of its source (`zoomSource`), else the system's own transition. The system
    /// cross-fades it under Reduce Motion. Pass a namespace that never comes and goes while the view lives: changing
    /// between one and nil replaces the view, and what it holds (a draft) with it.
    @ViewBuilder func zooms(from id: some Hashable, in namespace: Namespace.ID?) -> some View {
        if let namespace { navigationTransition(.zoom(sourceID: id, in: namespace)) } else { self }
    }
}

/// What a thing arriving looks like at its start: faded, blurred and 8 pt below its place (`amount` 1), or as it is (0).
private struct Blurred: ViewModifier {
    let amount: Double

    func body(content: Content) -> some View {
        content.opacity(1 - amount).offset(y: amount * 8)
    }
}

extension EnvironmentValues {
    /// The namespace profiles zoom out of (a face on a `pictures` block is their source); set once by the root.
    @Entry var profileZoom: Namespace.ID?

    /// Whether the words under it ink in as they come (Life's live answer): off for words that were already there.
    @Entry var inksWords = false
}

/// Life's words: while they come (`inksWords`) each word arrives from blur, one after another, in the order they are read;
/// words already shown never ink again. Plain text under Reduce Motion or when the words were there already.
struct InkText: View {
    let text: AttributedString
    @Environment(\.inksWords) private var inks
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// How many words are inked in so far (animated), and the count the animation is heading to.
    @State private var revealed = 0.0
    @State private var target = 0.0

    private var words: [Int] {
        var n = -1
        var wasSpace = true
        return text.characters.map { c in
            if c.isWhitespace { wasSpace = true } else if wasSpace { n += 1; wasSpace = false }
            return max(n, 0)
        }
    }

    var body: some View {
        let words = words
        let count = Double((words.last ?? 0) + 1)
        Text(text).textRenderer(
            InkRenderer(revealed: inks && !reduceMotion ? revealed : .greatestFiniteMagnitude, words: words)
        )
        .onChange(of: count, initial: true) {
            guard inks, !reduceMotion else { return }
            let goal = count + Motion.inkOverlap
            withAnimation(.linear(duration: max(goal - target, 1) * Motion.inkRate)) { revealed = goal }
            target = goal
        }
    }
}

private struct InkRenderer: TextRenderer {
    var revealed: Double
    let words: [Int]
    var animatableData: Double {
        get { revealed }
        set { revealed = newValue }
    }

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        var i = 0
        for line in layout {
            for run in line {
                for slice in run {
                    let word = Double(words[min(i, max(words.count - 1, 0))])
                    i += 1
                    let shown = min(max((revealed - word) / Motion.inkOverlap, 0), 1)
                    var c = context
                    c.opacity = shown
                    if shown < 1 {
                        c.translateBy(x: 0, y: (1 - shown) * 3)
                        c.addFilter(.blur(radius: (1 - shown) * 6))
                    }
                    c.draw(slice)
                }
            }
        }
    }
}

/// The thinking line's words: muted, with a bright sweep across them every `shimmer` seconds (still under Reduce Motion).
struct ShimmerText: View {
    let text: Text
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        text.foregroundStyle(Palette.muted).overlay {
            if !reduceMotion {
                TimelineView(.animation) { context in
                    let t =
                        context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Motion.shimmer)
                        / Motion.shimmer
                    let at = -0.3 + 1.6 * t
                    text.foregroundStyle(Palette.fg).mask {
                        LinearGradient(
                            stops: [
                                .init(color: .clear, location: at - 0.25), .init(color: .black, location: at),
                                .init(color: .clear, location: at + 0.25),
                            ], startPoint: .leading, endPoint: .trailing)
                    }
                }
            }
        }
    }
}

/// A row's wash: when `value` changes the row lights faintly and fades (`wash`), never on its first showing.
private struct Washes<Value: Equatable>: ViewModifier {
    let value: Value
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var level = 0.0

    func body(content: Content) -> some View {
        content
            .background(Palette.fg.opacity(level), in: .rect(cornerRadius: Metrics.Radius.block))
            .onChange(of: value) {
                guard !reduceMotion else { return }
                level = Motion.washLevel
                withAnimation(Motion.wash) { level = 0 }
            }
    }
}

extension View {
    /// Lights this view's place for a moment when `value` changes: how an item shows that its state changed.
    func washes(on value: some Equatable) -> some View { modifier(Washes(value: value)) }
}
