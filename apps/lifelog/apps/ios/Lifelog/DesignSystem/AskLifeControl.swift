import LifeConnector
import SwiftUI

/// Where Ask Life sits (the placement spec): its size and its margins from the root's bottom-right corner.
struct AskLifeMetrics: Equatable {
    let size: CGFloat, trailing: CGFloat, bottomCompact: CGFloat, bottomRegular: CGFloat
    /// The open card's margins: it sits above the foot bar, and in the Duo's column keeps its right clear of it.
    let cardLeading: CGFloat, cardTrailing: CGFloat, cardBottom: CGFloat

    func bottom(regular: Bool) -> CGFloat { regular ? bottomRegular : bottomCompact }

    static let phone = AskLifeMetrics(
        size: 52, trailing: 20, bottomCompact: 29, bottomRegular: 29, cardLeading: 16, cardTrailing: 16, cardBottom: 96)
    static let column = AskLifeMetrics(
        size: 48, trailing: 23, bottomCompact: 191, bottomRegular: 191, cardLeading: 14, cardTrailing: 98,
        cardBottom: 24)
}

/// Ask Life, one surface in three sizes (`ask-strip-2026-11-22.md`): the round button at rest; the strip, a glass card above
/// the foot bar; full screen, the same card with the stage above it. One glass morphs between them (`glassEffectID` in one
/// `GlassEffectContainer`), and the card's `DictationField` is one view in the strip and in full screen, so its run and its
/// words (`AskLife.draft`) are moved between sizes, never copied. The card is the one dictation field in its card form
/// (listening as it opens, words live, the meter, stop and Send) and one line of what Life answered; its grabber drags up
/// to full screen and down to put it away. Cancel folds it back and offers "Nothing sent · Undo" for 4 seconds.
struct AskLifeControl: View {
    let running: Int
    let place: AskLifeMetrics
    let isRegular: Bool

    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life
    @Namespace private var glass
    @State private var undoable: String?
    @State private var height: CGFloat = 800
    @GestureState private var isDragging = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var tell: AskLife { life.askLife }
    private var isFull: Bool { router.askLife == .full }
    private var draft: Binding<String> { Binding(get: { life.askLife.draft }, set: { life.askLife.draft = $0 }) }

    var body: some View {
        GlassEffectContainer {
            if router.askLife == .away {
                AskLifeButton(size: place.size, isWorking: running > 0 || tell.isBusy) {
                    router.isAskLifeListening = true
                    withAnimation(Motion.standard) { router.askLife = .strip }
                }
                .sensoryFeedback(.impact(weight: .medium), trigger: router.askLife == .strip)
                .glassEffectID("ask", in: glass)
                .padding(.trailing, place.trailing).padding(.bottom, place.bottom(regular: isRegular))
            } else {
                surface
            }
        }
        .frame(
            maxWidth: .infinity, maxHeight: .infinity, alignment: router.askLife == .away ? .bottomTrailing : .bottom
        )
        // A drag the system cancelled never reaches `onEnded`: the lift is let go with the finger.
        .onChange(of: isDragging) { _, dragging in if !dragging { router.askLifeLift = nil } }
        .onGeometryChange(for: CGFloat.self) {
            $0.size.height
        } action: {
            height = $0
        }
        .overlay(alignment: .bottomTrailing) {
            if let said = undoable, router.askLife == .away {
                Toast(words: "Nothing sent", glyph: nil, undo: { undo(said) })
                    .appears().padding(.trailing, place.trailing).padding(
                        .bottom, place.bottom(regular: isRegular) + 64
                    )
                    .task(id: said) {
                        try? await Task.sleep(for: .seconds(4))
                        withAnimation(Motion.standard) { undoable = nil }
                    }
            }
        }
        // The session is kept warm while Ask Life is out, so his first words start at once.
        .task(id: router.askLife != .away) {
            while router.askLife != .away, !Task.isCancelled {
                await tell.keepWarm()
                try? await Task.sleep(for: .seconds(240))
            }
        }
        // Words that waited for the Mac go as soon as the phone has a path again.
        .onChange(of: life.hasPath) { _, has in
            if has, tell.stage == .offline { Task { await tell.sendAgain(screen: router.mainSessionScreen) } }
        }
    }

    /// The card at the foot, in both sizes; the stage above it grows with the lift (`AppRouter.askLifeProgress`: the
    /// finger's, else the form's), so the strip and full screen are one view at two sizes. The cross comes with it.
    private var surface: some View {
        let lift = router.askLifeProgress
        return VStack(spacing: 0) {
            AskLifeStage().frame(maxHeight: lift * height).padding(.bottom, Metrics.Spacing.l * lift)
                .clipped().opacity(lift).allowsHitTesting(isFull).accessibilityHidden(!isFull)
            card
        }
        .frame(maxHeight: .infinity, alignment: .bottom)
        .overlay(alignment: .topTrailing) {
            CloseButton { withAnimation(Motion.standard) { router.putAwayAskLife(tell) } }
                .padding(.trailing, Metrics.gutter).opacity(lift).allowsHitTesting(isFull)
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            grabber
            DictationField(
                prompt: "Ask Life…", text: draft, axis: .vertical, listens: router.isAskLifeListening, send: submit,
                isCard: true, cancelled: cancel
            )
            .font(.body).foregroundStyle(Palette.fg)
            // Hidden while words wait in the field, and in full screen, where the stage holds the answer.
            // A list that does not fit here is one line, "Here's the list…": a tap opens it full screen.
            if !isFull, tell.draft.isEmpty, let line = router.pendingList(in: tell)?.label ?? tell.answer?.line {
                Button {
                    withAnimation(Motion.standard) { router.askLife = .full }
                } label: {
                    Text(line.withoutMarks).font(.small).foregroundStyle(Palette.muted).lineLimit(1)
                }
                .buttonStyle(.plain).accessibilityHint("Opens Ask Life full screen")
            }
        }
        .padding(.horizontal, Metrics.Spacing.l).padding(.bottom, Metrics.Spacing.xs)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 28))
        .glassEffectID("ask", in: glass)
        .padding(.leading, place.cardLeading).padding(.trailing, place.cardTrailing).padding(.bottom, place.cardBottom)
        .accessibilityIdentifier("ask.banner")
    }

    /// The grabber follows the finger between the strip and full screen, then springs to the nearer size the throw
    /// points at; a long pull down from the strip puts it away. Under Reduce Motion the settle is instant.
    private var grabber: some View {
        Capsule().fill(Palette.muted.opacity(0.5)).frame(width: 36, height: 5)
            .frame(maxWidth: .infinity, minHeight: Metrics.tapTarget / 2).contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 4)
                    .updating($isDragging) { _, state, _ in state = true }
                    .onChanged { router.askLifeLift = lift(after: $0.translation.height) }
                    .onEnded { settle($0) }
            )
            .accessibilityElement().accessibilityLabel(isFull ? "Make Ask Life small" : "Open Ask Life full screen")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { withAnimation(Motion.standard) { router.askLife = isFull ? .strip : .full } }
    }

    /// Where the lift stands after a drag of `dy` points (up is negative), over 60% of the screen's height.
    private func lift(after dy: CGFloat) -> CGFloat {
        min(1, max(0, (isFull ? 1 : 0) - dy / (height * 0.6)))
    }

    private func settle(_ drag: DragGesture.Value) {
        let isAway = !isFull && drag.translation.height > 40
        let target = lift(after: drag.predictedEndTranslation.height) > 0.5 ? AskLifeForm.full : .strip
        withAnimation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0)) {
            if isAway { router.putAwayAskLife(tell) } else { router.askLife = target }
            router.askLifeLift = nil
        }
    }

    private func submit() {
        // His words are never dropped: while Life works, they stay in the field.
        guard !tell.isBusy else { return }
        let words = tell.draft
        tell.draft = ""
        Task { await tell.send(words, screen: router.mainSessionScreen) }
    }

    private func cancel(_ said: String) {
        tell.draft = ""
        withAnimation(Motion.standard) {
            router.askLife = .away
            if !said.isEmpty { undoable = said }
        }
    }

    private func undo(_ said: String) {
        tell.draft = said
        router.isAskLifeListening = false
        withAnimation(Motion.standard) {
            undoable = nil
            router.askLife = .strip
        }
    }
}
