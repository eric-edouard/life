import SwiftUI

/// Spacing and corner radii from the approved mockups. Use these rather than numbers.
enum Metrics {
    /// Side margin of every page.
    static let gutter: CGFloat = 20
    static let cardPadding = Spacing.l

    /// Corner radii, smallest to largest.
    enum Radius {
        /// Photo tiles and thumbnails.
        static let tile: CGFloat = 10
        /// A small box inside a card: a text field, a swatch.
        static let field: CGFloat = 12
        /// The summary box, the highlighted transcript passage, compact cards.
        static let passage: CGFloat = 16
        /// Grouped rows and attention cards: Settings, the Pendant's cards, spending.
        static let group: CGFloat = 20
        /// The Pendant's figures.
        static let card: CGFloat = 22
        /// The floating player.
        static let player: CGFloat = 30
    }

    /// Space between and inside elements, on a 4-point grid.
    enum Spacing {
        static let xs: CGFloat = 4
        static let l: CGFloat = 16
    }
}
