import SwiftUI

/// Spacing and corner radii from the approved mockups. Use these rather than numbers.
enum Metrics {
    /// Side margin of every page.
    static let gutter: CGFloat = 20
    static let cardPadding = Spacing.l

    /// Corner radii, smallest to largest.
    enum Radius {
        /// A quote inside a draft, photo tiles and thumbnails.
        static let tile: CGFloat = 10
        /// A draft, a quote, a clip, a multi-line field.
        static let passage: CGFloat = 16
        /// Every card, row group and box.
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
