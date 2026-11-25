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
    /// A row of a list (a grouped inset card): the asks, the matters, the people.
    static let listRow: CGFloat = 60
    /// The height of Spending's bars, a day each.
    static let trend: CGFloat = 72

    /// The Pendant sheet's tiles: a stat tile's height, the light's square, the storage ring.
    enum Tile {
        static let statHeight: CGFloat = 128
        static let light: CGFloat = 84
        static let ring: CGFloat = 56
        static let battery: CGFloat = 71
    }

    /// A flat list row (the agent's wake list, the people sheet), and the round slot that leads it.
    enum FlatRow {
        static let row: CGFloat = 48
        static let slot: CGFloat = 32
        /// A bulk card's row: a tick or a Yes and No, and two lines.
        static let bulkRow: CGFloat = 64
        /// The people sheet's larger lead.
        static let personSlot: CGFloat = 40
        /// A person's row in the people sheet (`party_row` at 52).
        static let personRow: CGFloat = 52
    }

    /// Corner radii (docs/brand.md, Shape): a button is a full pill, the other three are these.
    enum Radius {
        /// A small control, a quote inside a draft, a thumbnail, a field.
        static let control: CGFloat = 12
        /// A block in the thread: an option card, a box, a settings block, a draft, a row group.
        static let block: CGFloat = 18
        /// A sheet, a panel, the floating player.
        static let sheet: CGFloat = 22
    }

    /// Space between and inside elements, on a 4-point grid.
    enum Spacing {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 24
        static let xxl: CGFloat = 48
    }
}
