import SwiftUI

/// `TimelineView(.animation)` that also stops while it is scrolled out of sight, its tab is hidden, the app isn't
/// active, or its scroll view is moving (`stillWhileScrolling()`). The Pendant screen stays open for hours, so nothing
/// on it may tick unseen, and a scroll frame carries only the scroll.
struct OnScreenTimeline<Content: View>: View {
    /// Frames no closer than this many seconds; `nil` for the display's rate.
    var minimumInterval: Double?
    let paused: Bool
    @ViewBuilder let content: (Date) -> Content

    @State private var inView = true
    @State private var appeared = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.isScrolling) private var isScrolling

    var body: some View {
        let still = paused || !inView || !appeared || scenePhase != .active || isScrolling
        TimelineView(.animation(minimumInterval: minimumInterval, paused: still)) { context in
            content(context.date)
        }
        .onScrollVisibilityChange(threshold: 0.01) { inView = $0 }
        .onAppear { appeared = true }
        .onDisappear { appeared = false }
    }
}

extension EnvironmentValues {
    /// The enclosing scroll view is moving (`stillWhileScrolling()`): animations hold still meanwhile.
    @Entry var isScrolling = false
}

extension View {
    /// Tells this scroll view's content when it moves, through `isScrolling`. The phase lives here, so a scroll starting
    /// wakes only the views that read it, never the screen around them.
    func stillWhileScrolling() -> some View { modifier(ScrollingEnvironment()) }
}

private struct ScrollingEnvironment: ViewModifier {
    @State private var isScrolling = false

    func body(content: Content) -> some View {
        content
            .onScrollPhaseChange { _, phase in isScrolling = phase.isScrolling }
            .environment(\.isScrolling, isScrolling)
    }
}
