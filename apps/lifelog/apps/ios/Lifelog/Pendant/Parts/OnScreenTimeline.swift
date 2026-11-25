import SwiftUI

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
