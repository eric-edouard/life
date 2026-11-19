import SwiftUI

/// The two fills pieces sit on, apart so the notification extension draws a draft as the card does.
extension Color {
    /// The quiet fill of a secondary button or a chip: the page's ink at a low strength, as the design's `--tint`.
    static let fillTint = Palette.fg.opacity(0.08)
}

extension View {
    /// A draft, a piece of evidence or a clip on paper: the `paper` fill at the passage radius (a quote sits on `tile`).
    func paperBox() -> some View {
        background(Palette.paper, in: .rect(cornerRadius: Metrics.Radius.passage))
    }
}
