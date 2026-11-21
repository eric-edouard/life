import SwiftUI

/// Where Tell Life sits (the placement spec): its size and its margins from the root's bottom-right corner.
struct TellMetrics: Equatable {
    let size: CGFloat, trailing: CGFloat, bottomCompact: CGFloat, bottomRegular: CGFloat

    func bottom(regular: Bool) -> CGFloat { regular ? bottomRegular : bottomCompact }

    static let phone = TellMetrics(size: 52, trailing: 20, bottomCompact: 29, bottomRegular: 29)
    static let column = TellMetrics(size: 48, trailing: 18, bottomCompact: 35, bottomRegular: 24)
}

/// Ask Life: the round button at rest, a wide banner along the bottom when open. One glass that morphs between them
/// (`glassEffectID` in one `GlassEffectContainer`). The banner holds the dictation (`AskDictationSlot`, the dictation
/// helper's component) and one line of what Life answered; the X, or a swipe down, morphs it back.
struct AskLife: View {
    let running: Int
    let place: TellMetrics
    let isRegular: Bool

    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life
    @Namespace private var glass

    var body: some View {
        GlassEffectContainer {
            if router.isAskOpen {
                banner
            } else {
                TellLifeButton(running: running, size: place.size)
                    .glassEffectID("ask", in: glass)
                    .padding(.trailing, place.trailing)
            }
        }
        .padding(.bottom, place.bottom(regular: isRegular))
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var banner: some View {
        HStack(spacing: Metrics.Spacing.m) {
            TellMark(size: 20)
            VStack(alignment: .leading, spacing: 2) {
                AskDictationSlot()
                if let line = life.tell.answer?.line {
                    Text(line.withoutMarks).font(.small).foregroundStyle(Palette.muted).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Button("Open", systemImage: "arrow.up.left.and.arrow.down.right") {
                withAnimation(Motion.standard) { router.isAskOpen = false }
                router.isTellLifeOpen = true
            }
            .labelStyle(.iconOnly)
            Button("Put away", systemImage: "xmark", role: .close) {
                withAnimation(Motion.standard) { router.isAskOpen = false }
            }
            .labelStyle(.iconOnly)
        }
        .buttonStyle(.plain).foregroundStyle(Palette.muted)
        .padding(.horizontal, Metrics.Spacing.l).frame(height: place.size + 8)
        .glassEffect(.regular, in: Capsule())
        .glassEffectID("ask", in: glass)
        // The content column's edges: the column's right 98 stays clear for the tabs and the button that morphed.
        .padding(.leading, place == .column ? 14 : 20).padding(.trailing, place == .column ? 98 : 20)
        .gesture(
            DragGesture(minimumDistance: 24).onEnded { drag in
                if drag.translation.height > 24 { withAnimation(Motion.standard) { router.isAskOpen = false } }
            }
        )
        .accessibilityIdentifier("ask.banner")
    }
}

/// Where the dictation helper's component goes: his live words, "Swipe up" to send. Until it lands, a prompt.
private struct AskDictationSlot: View {
    var body: some View {
        Text("Ask Life…").font(.body).foregroundStyle(Palette.fg).lineLimit(1)
    }
}
