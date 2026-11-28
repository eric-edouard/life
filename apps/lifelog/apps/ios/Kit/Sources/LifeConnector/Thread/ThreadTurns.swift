import Foundation

/// Ask Life's thread turn by turn (the owner's decision of 28 Nov 2026): his question heads its turn, pinned while its
/// answer scrolls under it, and a release near a turn's top settles there.
public enum ThreadTurns {
    /// His question's size, stepped down by its length: the same pinned and unpinned.
    public enum QuestionSize: Equatable, Sendable { case short, medium, long }

    public static func size(of question: String) -> QuestionSize {
        switch question.count {
        case ..<48: .short
        case ..<120: .medium
        default: .long
        }
    }

    /// Where a scroll released toward `target` settles: the nearest turn top within `reach`, else where it was going,
    /// so a long answer scrolls freely and nothing snaps mid-answer.
    public static func settled(_ target: Double, tops: [Double], reach: Double) -> Double {
        guard let top = tops.min(by: { abs($0 - target) < abs($1 - target) }), abs(top - target) <= reach else {
            return target
        }
        return top
    }
}
