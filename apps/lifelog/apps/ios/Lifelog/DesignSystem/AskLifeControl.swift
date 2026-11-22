import SwiftUI

/// Where Ask Life sits (the placement spec): its size and its margins from the root's bottom-right corner.
struct AskLifeMetrics: Equatable {
    let size: CGFloat, trailing: CGFloat, bottomCompact: CGFloat, bottomRegular: CGFloat

    func bottom(regular: Bool) -> CGFloat { regular ? bottomRegular : bottomCompact }

    static let phone = AskLifeMetrics(size: 52, trailing: 20, bottomCompact: 29, bottomRegular: 29)
    static let column = AskLifeMetrics(size: 48, trailing: 23, bottomCompact: 191, bottomRegular: 191)
}

/// Ask Life: the round button at rest, a glass card above the foot bar when open. One glass that morphs between them
/// (`glassEffectID` in one `GlassEffectContainer`). The card is the one dictation field in its card form (listening as it
/// opens, words live, the meter, stop and Send) and one line of what Life answered. Cancel folds it back and offers
/// "Nothing sent · Undo" for 4 seconds; Undo brings the card back with his words.
struct AskLifeControl: View {
    let running: Int
    let place: AskLifeMetrics
    let isRegular: Bool

    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life
    @Namespace private var glass
    @State private var draft = ""
    /// Whether the card opens listening: not when Undo brings it back with his words.
    @State private var listens = true
    @State private var undoable: String?

    var body: some View {
        GlassEffectContainer {
            if router.isAskOpen {
                card
            } else {
                AskLifeButton(size: place.size, isWorking: running > 0 || life.askLife.isBusy) {
                    listens = true
                    withAnimation(Motion.standard) { router.isAskOpen = true }
                }
                .sensoryFeedback(.impact(weight: .medium), trigger: router.isAskOpen) { _, new in new }
                .glassEffectID("ask", in: glass)
                .padding(.trailing, place.trailing).padding(.bottom, place.bottom(regular: isRegular))
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .overlay(alignment: .bottomTrailing) {
            if let said = undoable, !router.isAskOpen {
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
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            DictationField(
                prompt: "Ask Life…", text: $draft, axis: .vertical, listens: listens, send: submit, isCard: true,
                cancelled: cancel
            )
            .font(.body).foregroundStyle(Palette.fg)
            // Hidden while words wait in the field: opening the screen would drop them with no Undo.
            if draft.isEmpty, let line = life.askLife.answer?.line {
                Button {
                    withAnimation(Motion.standard) { router.isAskOpen = false }
                    router.isAskLifeOpen = true
                } label: {
                    Text(line.withoutMarks).font(.small).foregroundStyle(Palette.muted).lineLimit(1)
                }
                .buttonStyle(.plain).accessibilityHint("Opens Ask Life")
            }
        }
        .padding(.horizontal, Metrics.Spacing.l).padding(.bottom, Metrics.Spacing.xs)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 28))
        .glassEffectID("ask", in: glass)
        // The root spans the Duo's side column too: the card keeps its right 98 clear for the column. Above the foot bar.
        .padding(.leading, place == .column ? 14 : 16).padding(.trailing, place == .column ? 98 : 16)
        .padding(.bottom, place == .column ? 24 : 96)
        .accessibilityIdentifier("ask.banner")
    }

    private func submit() {
        // His words are never dropped: while Life works, they stay in the field.
        guard !life.askLife.isBusy else { return }
        let words = draft
        draft = ""
        Task { await life.askLife.send(words, screen: router.mainSessionScreen) }
    }

    private func cancel(_ said: String) {
        draft = ""
        withAnimation(Motion.standard) {
            router.isAskOpen = false
            if !said.isEmpty { undoable = said }
        }
    }

    private func undo(_ said: String) {
        draft = said
        listens = false
        withAnimation(Motion.standard) {
            undoable = nil
            router.isAskOpen = true
        }
    }
}
