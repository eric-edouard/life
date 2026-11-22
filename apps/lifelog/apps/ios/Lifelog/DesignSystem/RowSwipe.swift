import SwiftUI

/// One row's swipe answers, each a small rounded button beside the row (never a colour over it): right is the row's main
/// answer (`fg` on `on`), left is Drop (`flag` at 16%). A swipe past half the row taps it; a tap shows its work in the
/// button until `run` returns, then the row settles. Vertical drags stay the list's.
struct RowSwipe: ViewModifier {
    struct Button {
        let label: String
        let symbol: String
        /// Said while it runs, in the button.
        let working: String
        let run: () async -> Void
    }

    let main: Button?
    let drop: Button?

    @State private var offset: CGFloat = 0
    @State private var width: CGFloat = 0
    @State private var isHorizontal: Bool?
    @State private var busy: Bool?
    @State private var start: CGFloat = 0

    private static let size = CGSize(width: 96, height: 44)
    private static let gap = Metrics.Spacing.s
    private var open: CGFloat { Self.size.width + Self.gap + Metrics.Spacing.xs }

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .leading) { button(main, isMain: true, at: -(Self.size.width + Self.gap)) }
            .overlay(alignment: .trailing) { button(drop, isMain: false, at: Self.size.width + Self.gap) }
            .offset(x: offset)
            .onGeometryChange(for: CGFloat.self) {
                $0.size.width
            } action: {
                width = $0
            }
            .simultaneousGesture(drag)
            .motion(Motion.standard, value: busy)
    }

    @ViewBuilder private func button(_ swipe: Button?, isMain: Bool, at x: CGFloat) -> some View {
        if let swipe {
            let isBusy = busy == isMain
            SwiftUI.Button {
                Task { await run(swipe, isMain: isMain) }
            } label: {
                HStack(spacing: Metrics.Spacing.xs) {
                    if isBusy { Spinner(size: .small) } else { Image(systemName: swipe.symbol) }
                    Text(isBusy ? swipe.working : swipe.label).lineLimit(1)
                }
                .font(.smallStrong)
                .foregroundStyle(isMain ? Palette.on : Palette.flag)
                .frame(width: Self.size.width, height: Self.size.height)
                .background(
                    isMain ? Palette.fg : Palette.flag.opacity(0.16), in: .rect(cornerRadius: 16, style: .continuous))
            }
            .buttonStyle(.plain).disabled(busy != nil)
            .offset(x: x)
            // Hidden from VoiceOver until the row is open; the row's own menu holds the same answers.
            .opacity(offset == 0 ? 0 : 1).accessibilityHidden(offset == 0)
        }
    }

    private func run(_ swipe: Button, isMain: Bool) async {
        busy = isMain
        await swipe.run()
        busy = nil
        withAnimation(Motion.standard) { offset = 0 }
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 16)
            .onChanged { drag in
                if isHorizontal == nil {
                    isHorizontal = abs(drag.translation.width) > abs(drag.translation.height) * 1.5
                    start = offset
                }
                guard isHorizontal == true, busy == nil else { return }
                offset = clamped(start + drag.translation.width)
            }
            .onEnded { drag in
                defer { isHorizontal = nil }
                guard isHorizontal == true, busy == nil else { return }
                let isRight = offset > 0
                if abs(offset) > width / 2, let swipe = isRight ? main : drop {
                    // A long swipe taps it: the row holds open on its working button.
                    withAnimation(Motion.standard) { offset = isRight ? open : -open }
                    Task { await run(swipe, isMain: isRight) }
                } else {
                    let end = start + drag.predictedEndTranslation.width
                    withAnimation(Motion.standard) { offset = abs(end) > open / 2 ? (end > 0 ? open : -open) : 0 }
                }
            }
    }

    private func clamped(_ value: CGFloat) -> CGFloat {
        min(main == nil ? 0 : width, max(drop == nil ? 0 : -width, value))
    }
}

extension View {
    /// Swipe right for `main`, left for `drop`; nil on a side with no answer.
    func rowSwipe(main: RowSwipe.Button?, drop: RowSwipe.Button?) -> some View {
        modifier(RowSwipe(main: main, drop: drop))
    }
}
