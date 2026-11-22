import SwiftUI

/// Where Ask Life sits (the placement spec): its size and its margins from the root's bottom-right corner.
struct AskLifeMetrics: Equatable {
    let size: CGFloat, trailing: CGFloat, bottomCompact: CGFloat, bottomRegular: CGFloat

    func bottom(regular: Bool) -> CGFloat { regular ? bottomRegular : bottomCompact }

    static let phone = AskLifeMetrics(size: 52, trailing: 20, bottomCompact: 29, bottomRegular: 29)
    static let column = AskLifeMetrics(size: 48, trailing: 23, bottomCompact: 191, bottomRegular: 191)
}

/// Ask Life: the round button at rest, a wide banner along the bottom when open. One glass that morphs between them
/// (`glassEffectID` in one `GlassEffectContainer`). The banner holds the dictation (`AskDictationSlot`, a
/// `DictationField` that listens as it opens) and one line of what Life answered; the X, or a swipe down, morphs it back.
struct AskLifeControl: View {
    let running: Int
    let place: AskLifeMetrics
    let isRegular: Bool

    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life
    @Namespace private var glass

    var body: some View {
        GlassEffectContainer {
            if router.isAskOpen {
                banner
            } else {
                AskLifeButton(size: place.size, isWorking: running > 0 || life.askLife.isBusy) {
                    withAnimation(Motion.standard) { router.isAskOpen = true }
                }
                .sensoryFeedback(.impact(weight: .medium), trigger: router.isAskOpen) { _, new in new }
                .glassEffectID("ask", in: glass)
                .padding(.trailing, place.trailing).padding(.bottom, place.bottom(regular: isRegular))
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var banner: some View {
        HStack(spacing: Metrics.Spacing.m) {
            AskLifeMark(size: 20)
            VStack(alignment: .leading, spacing: 2) {
                AskDictationSlot()
                if let line = life.askLife.answer?.line {
                    Text(line.withoutMarks).font(.small).foregroundStyle(Palette.muted).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Button("Open", systemImage: "arrow.up.left.and.arrow.down.right") {
                withAnimation(Motion.standard) { router.isAskOpen = false }
                router.isAskLifeOpen = true
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
        // The root spans the Duo's side column too: the banner keeps its right 98 clear for the column (its tabs).
        .padding(.leading, place == .column ? 14 : 20).padding(.trailing, place == .column ? 98 : 20)
        .gesture(
            DragGesture(minimumDistance: 24).onEnded { drag in
                if drag.translation.height > 24 { withAnimation(Motion.standard) { router.isAskOpen = false } }
            }
        )
        .padding(.bottom, AskLifeMetrics.phone.bottomCompact)
        .accessibilityIdentifier("ask.banner")
    }
}

/// The banner's words: the one dictation field, listening as the banner opens (the tap that opened it was the
/// microphone's), its Send handing his words to Ask Life as the full screen's does.
private struct AskDictationSlot: View {
    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life
    @State private var draft = ""

    var body: some View {
        DictationField(prompt: "Ask Life…", text: $draft, listens: true, send: submit)
            .font(.body).foregroundStyle(Palette.fg).lineLimit(1)
    }

    private func submit() {
        // His words are never dropped: while Life works, they stay in the field.
        guard !life.askLife.isBusy else { return }
        let words = draft
        draft = ""
        Task { await life.askLife.send(words, screen: router.mainSessionScreen) }
    }
}
