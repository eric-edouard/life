import SwiftUI

/// A device fact with how much to trust it, decided once where `now` is known so tiles never need a clock.
enum Fact<Value: Equatable>: Equatable {
    /// Reported by a connected Pendant within one sync cycle.
    case current(Value, at: Date)
    /// True when reported, maybe not now.
    case lastKnown(Value, at: Date)
    case unknown

    var value: Value? {
        switch self {
        case .current(let value, _), .lastKnown(let value, _): value
        case .unknown: nil
        }
    }

    var currentValue: Value? {
        if case .current(let value, _) = self { value } else { nil }
    }

    var at: Date? {
        switch self {
        case .current(_, let at), .lastKnown(_, let at): at
        case .unknown: nil
        }
    }
}

/// Cards in columns, rows sharing the height of their tallest card. A card left alone in its row spans it, so no row
/// has an empty slot.
struct GlanceGridLayout: Layout {
    var columns: Int
    var spacing: CGFloat = 10

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 360
        return CGSize(width: width, height: frames(width: width, subviews: subviews).map(\.maxY).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, frame) in zip(subviews, frames(width: bounds.width, subviews: subviews)) {
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(frame.size))
        }
    }

    private func frames(width: CGFloat, subviews: Subviews) -> [CGRect] {
        let columnWidth = (width - spacing * CGFloat(columns - 1)) / CGFloat(columns)
        var frames = [CGRect](repeating: .zero, count: subviews.count)
        var y: CGFloat = 0
        for start in stride(from: 0, to: subviews.count, by: columns) {
            let row = start..<min(start + columns, subviews.count)
            let itemWidth = row.count == 1 ? width : columnWidth
            let height =
                row.map { subviews[$0].sizeThatFits(ProposedViewSize(width: itemWidth, height: nil)).height }
                .max() ?? 0
            for index in row {
                frames[index] = CGRect(
                    x: CGFloat(index - start) * (columnWidth + spacing), y: y, width: itemWidth, height: height)
            }
            y += height + spacing
        }
        return frames
    }
}

/// The big figure of a card with its line underneath, and an optional thin bar. A glyph can lead the figure.
struct TileFigure<Leading: View>: View {
    let value: Text
    let caption: String
    var emphasis = false
    /// 0...1, drawn as a hairline bar; `nil` draws none.
    var fraction: Double?
    @ViewBuilder var leading: Leading

    @Environment(\.accessibilityDifferentiateWithoutColor) private var withoutColor

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                leading.alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                if emphasis && withoutColor {
                    // Red alone would be the only sign; the caption says what is wrong.
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Palette.redText)
                        .accessibilityHidden(true)
                }
                value
                    .font(.monoFigure)
                    .foregroundStyle(emphasis ? Palette.redText : Palette.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .contentTransition(.numericText())
            }
            Text(caption)
                .font(.caption)
                .foregroundStyle(Palette.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            if let fraction {
                Capsule()
                    .fill(Palette.hairline)
                    .frame(height: 3)
                    .overlay(alignment: .leading) {
                        GeometryReader { proxy in
                            Capsule()
                                .fill(emphasis ? Palette.redText : Palette.textBody)
                                .frame(width: proxy.size.width * min(max(fraction, 0), 1))
                        }
                    }
                    .padding(.top, 7)
                    .accessibilityHidden(true)
            }
        }
    }
}

extension TileFigure where Leading == EmptyView {
    init(value: Text, caption: String, emphasis: Bool = false, fraction: Double? = nil) {
        self.init(value: value, caption: caption, emphasis: emphasis, fraction: fraction) { EmptyView() }
    }
}

/// One fact in a detail list: name on the leading edge, value in mono on the trailing edge.
struct TileRow: View {
    let label: String
    let value: Text

    init(_ label: String, _ value: Text) {
        self.label = label
        self.value = value
    }

    init(_ label: String, _ value: String) {
        self.init(label, Text(value))
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).foregroundStyle(Palette.textSecondary)
            Spacer(minLength: 8)
            value
                .font(.monoDetail)
                .foregroundStyle(Palette.textPrimary)
                .multilineTextAlignment(.trailing)
        }
        .font(.footnote)
        .padding(.vertical, 9)
        .overlay(alignment: .top) { Hairline() }
        .accessibilityElement(children: .combine)
    }
}
