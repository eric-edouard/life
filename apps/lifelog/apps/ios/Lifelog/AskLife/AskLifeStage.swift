import LifeConnector
import ServerAPI
import SwiftUI

/// What Ask Life shows above its card when it is full screen: his last words as a caption, then the present (Life's
/// work, or its answer with its chips), never a history. The card below is the strip's, the same view moved, not copied.
struct AskLifeStage: View {
    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life
    /// The card an answer's chip points at is no longer open: said in place, the screen stays.
    @State private var isCardGone = false

    private var tell: AskLife { life.askLife }

    var body: some View {
        ScrollView {
            VStack(spacing: Metrics.Spacing.l) {
                if let context = router.askLifeContext {
                    QuietChip(context.question, symbol: "xmark", isMuted: true) { router.askLifeContext = nil }
                }
                if !tell.said.isEmpty {
                    Text(tell.said).font(.small).foregroundStyle(Palette.muted).lineLimit(2)
                        .multilineTextAlignment(.center).appears(Motion.fade)
                }
                stage.frame(maxWidth: .infinity)
            }
            .padding(.horizontal, Metrics.gutter)
        }
        // The stage is bottom-aligned: its foot rests on the card.
        .defaultScrollAnchor(.bottom).scrollBounceBehavior(.basedOnSize)
        .motion(Motion.standard, value: tell.stage)
        .motion(Motion.standard, value: tell.answer)
        .motion(Motion.standard, value: isCardGone)
        .onChange(of: tell.answer) { isCardGone = false }
    }

    @ViewBuilder private var stage: some View {
        VStack(spacing: Metrics.Spacing.l) {
            switch tell.stage {
            case .thinking:
                AskLifeLightLine(kind: .point)
                note("Thinking…")
            case .working:
                working
            case .offline:
                AskLifeLightLine(kind: .waiting)
                head("Your Mac is offline")
                note("This goes as soon as it's back.")
                if let waiting = tell.waiting { AskLifeWaitingPill(words: waiting) }
            case .ready:
                answer
            }
        }
        .multilineTextAlignment(.center)
        .appears(Motion.fade)
        .id(tell.stage)
    }

    private var working: some View {
        VStack(spacing: Metrics.Spacing.l) {
            if tell.words.isEmpty {
                AskLifeLightLine(kind: .point)
            } else {
                AskLifeLightLine(kind: .answer); head(tell.words)
            }
            ForEach(tell.strands) { AskLifeStrandRow(title: $0.title, isDone: $0.isDone) }
        }
    }

    @ViewBuilder private var answer: some View {
        if let answer = tell.answer {
            AskLifeAnswerView(answer: answer, again: again, open: open, tell: say)
            // The list the answer names: opening it shrinks Ask Life to the strip, so the list is in view and the
            // conversation goes on beneath it.
            if let list = router.pendingList(in: tell), let shown = tell.shown {
                QuietChip(list.label, symbol: "list.bullet") {
                    router.askLifeApplied = shown.answer
                    withAnimation(Motion.standard) { router.open(shown: shown.show) }
                }
            }
            if isCardGone { StateMark(glyph: .flag, word: "That ask is no longer open") }
        } else {
            AskLifeLightLine(kind: .ready)
            note("Tap or hold the microphone to talk, then Send.")
        }
    }

    private func again() { Task { await tell.sendAgain(screen: router.mainSessionScreen) } }
    /// An answer's own chip or button gives words: they go as his, like any others.
    private func say(_ words: String) { Task { await tell.send(words, screen: router.mainSessionScreen) } }

    /// What an answer's chip points at, by ref: a person or an organization, a card in the Inbox, else a matter.
    private func open(_ ref: String) {
        isCardGone = false
        if ref.hasPrefix("dec_") {
            // A card that is gone keeps Ask Life open and says so.
            Task {
                guard await life.open(ref: ref) else { return isCardGone = true }
                router.askLife = .away
                // An ask of a matter is in that matter's thread; one of no matter is the Inbox's.
                if let matter = life.inbox.value?.checks.first(where: { $0.ref == ref })?.matterID {
                    router.open(matter: matter)
                } else {
                    router.tab = .inbox
                }
            }
            return
        }
        router.askLife = .away
        if ref.hasPrefix("person:") { router.open(party: ref) } else { router.open(matter: ref) }
    }

    private func head(_ words: String) -> some View { AskLifeHead(words: words) }
    private func note(_ words: String) -> some View { AskLifeNote(words: words) }
}
