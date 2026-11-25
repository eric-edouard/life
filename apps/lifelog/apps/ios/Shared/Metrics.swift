import SwiftUI

/// Spacing and corner radii from the approved mockups. Use these rather than numbers.
enum Metrics {
    /// Side margin of a full page (the profile's 20); the thread, its wash and the field use `Spacing.l`, the prototype's 16.
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

    /// A round icon disc leading a thread row; a reaction's corner mark; a still pie (small, and in a line); a colour swatch.
    static let disc: CGFloat = 40
    /// A profile's face.
    static let profileFace: CGFloat = 96
    static let reactionMark: CGFloat = 24
    static let pie: CGFloat = 18
    static let pieSmall: CGFloat = 12
    static let swatch: CGFloat = 32
    /// A small mark (the needs-you dot); a rating's tap mark.
    static let flagDot: CGFloat = 7
    static let ratingMark: CGFloat = 36
    /// A switch: its track and its knob.
    static let switchTrack = CGSize(width: 51, height: 31)
    static let switchKnob: CGFloat = 27
    /// A bubble's widest, and the catalog's phone width.
    static let bubbleWidth: CGFloat = 300
    static let phoneWidth: CGFloat = 393

    /// How faded a thing goes: an outdated row, an answer beside a busy one, a draft redrafted past.
    enum Opacity {
        static let faded = 0.4
        static let dim = 0.5
        static let earlier = 0.6
    }

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
        /// The aura's ring, the corner of the screen (an iPhone's, near enough).
        static let screen: CGFloat = 55
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
