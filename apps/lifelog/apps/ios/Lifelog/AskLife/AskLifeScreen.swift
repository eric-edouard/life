import LifeConnector
import ServerAPI
import SwiftUI

/// Ask Life, full screen: one place to say anything to Life from any screen. His last words sit as a caption, the stage
/// shows the present (never a history), and the foot is the composer: his words in a capsule, the one microphone
/// (`DictationField`: tap, or hold, to talk) and Send, or a hold slid up from the microphone. Not a live conversation:
/// he records, then sends.
struct AskLifeScreen: View {
    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life
    @State private var draft = ""

    private var tell: AskLife { life.askLife }

    /// Closes to the strip when there is something to keep in sight, else just closes.
    private func makeSmall() {
        router.isAskLifeSmall = tell.stage != .ready || tell.answer != nil
        router.isAskLifeOpen = false
    }

    var body: some View {
        VStack(spacing: Metrics.Spacing.l) {
            HStack {
                AskLifeSmallButton(action: makeSmall)
                Spacer()
                CloseButton {
                    router.askLifeContext = nil
                    router.isAskLifeSmall = false
                    router.isAskLifeOpen = false
                }
            }
            if let context = router.askLifeContext {
                QuietChip(context.question, symbol: "xmark", isMuted: true) { router.askLifeContext = nil }
            }
            if !tell.said.isEmpty {
                Text(tell.said).font(.small).foregroundStyle(Palette.muted).lineLimit(2).multilineTextAlignment(.center)
                    .appears(Motion.fade)
            }
            Spacer(minLength: 0)
            stage.frame(maxWidth: .infinity)
            Spacer(minLength: 0)
            composer
        }
        .padding(.horizontal, Metrics.gutter).padding(.vertical, Metrics.Spacing.l)
        .background(AskLifeRoom())
        .onAppear { router.isAskLifeSmall = false }
        // Swipe down makes it small.
        .gesture(DragGesture().onEnded { if $0.translation.height > 120 { makeSmall() } })
        .motion(Motion.standard, value: tell.stage)
        .motion(Motion.standard, value: tell.answer)
        // The session is kept warm while the screen stays open, so his first words start at once.
        .task {
            while !Task.isCancelled {
                await tell.keepWarm()
                try? await Task.sleep(for: .seconds(240))
            }
        }
        // Words that waited for the Mac go as soon as the phone has a path again.
        .onChange(of: life.hasPath) { _, has in
            if has, tell.stage == .offline { Task { await tell.sendAgain(screen: router.mainSessionScreen) } }
        }
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
        router.isAskLifeOpen = false
        if ref.hasPrefix("person:") {
            router.open(party: ref)
        } else if ref.hasPrefix("dec_") {
            router.tab = .inbox
            Task { await life.open(ref: ref) }
        } else {
            router.open(matter: ref)
        }
    }

    private func head(_ words: String) -> some View { AskLifeHead(words: words) }
    private func note(_ words: String) -> some View { AskLifeNote(words: words) }

    /// The foot, chat style: his words, the microphone, Send; every element keeps its place.
    private var composer: some View {
        DictationField(prompt: "Ask Life…", text: $draft, axis: .vertical, send: submit)
            .askLifeComposer()
    }

    private func submit() {
        // His words are never dropped: while Life works, they stay in the field.
        guard !tell.isBusy else { return }
        let words = draft
        draft = ""
        Task { await tell.send(words, screen: router.mainSessionScreen) }
    }
}
