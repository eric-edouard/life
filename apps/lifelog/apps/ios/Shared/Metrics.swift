import SwiftUI

/// Spacing and corner radii from the approved mockups. Use these rather than numbers.
enum Metrics {
    /// Side margin of every page.
    static let gutter: CGFloat = 20
    static let cardPadding = Spacing.l

    /// The state dot beside a status word.
    static let dot: CGFloat = 9
    /// The smallest tap target.
    static let tapTarget: CGFloat = 44

    /// The Pendant sheet's tiles: a stat tile's height, the light's square, the storage ring.
    enum Tile {
        static let statHeight: CGFloat = 128
        static let light: CGFloat = 84
        static let ring: CGFloat = 56
    }

    /// Corner radii, smallest to largest.
    enum Radius {
        /// A quote inside a draft, photo tiles and thumbnails.
        static let tile: CGFloat = 10
        /// A draft, a piece of evidence, a clip, a multi-line field.
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
