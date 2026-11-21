import LifeConnector
import SwiftUI

/// Tell Life, full screen: one place to say anything to Life from any screen. His last words sit as a caption, the stage
/// shows the present (never a history), and the foot is the composer: his words in a capsule, the one microphone
/// (`DictationField`: tap, or hold, to talk) and Send, or a swipe up from the microphone. Not a live conversation:
/// he records, then sends.
struct TellLifeScreen: View {
    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life
    @State private var draft = ""

    private var tell: TellLife { life.tell }

    var body: some View {
        VStack(spacing: Metrics.Spacing.l) {
            HStack {
                Spacer()
                CloseButton { router.isTellLifeOpen = false }
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
        .background(background)
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
            if has, tell.stage == .offline { Task { await tell.sendAgain(screen: router.tellScreen) } }
        }
    }

    /// The room: a faint `ai` glow behind the stage.
    private var background: some View {
        ZStack {
            Palette.bg
            RadialGradient(colors: [Palette.ai.opacity(0.12), .clear], center: .center, startRadius: 0, endRadius: 280)
        }
        .ignoresSafeArea()
    }

    @ViewBuilder private var stage: some View {
        VStack(spacing: Metrics.Spacing.l) {
            switch tell.stage {
            case .thinking:
                TellLine(kind: .point)
                note("Thinking…")
            case .working:
                working
            case .offline:
                TellLine(kind: .waiting)
                head("Your Mac is offline")
                note("This goes as soon as it's back.")
                if let waiting = tell.waiting { waitingPill(waiting) }
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
            if tell.words.isEmpty { TellLine(kind: .point) } else { TellLine(kind: .answer); head(tell.words) }
            ForEach(tell.strands) { TellStrandRow(title: $0.title, isDone: $0.isDone) }
        }
    }

    @ViewBuilder private var answer: some View {
        switch tell.answer {
        case nil:
            TellLine(kind: .ready)
            note("Tap or hold the microphone. Swipe up from it, or tap Send.")
        case .reply(let words)?:
            TellLine(kind: .answer)
            head(words)
        case .error(let what)?:
            TellLine(kind: .broken)
            head(what)
            note("Your words are kept.")
            QuietChip("Try again", symbol: "arrow.clockwise") {
                Task { await tell.sendAgain(screen: router.tellScreen) }
            }
        case .unknown?:
            TellLine(kind: .broken)
            head("Life answered in a way this app can't show yet.")
        }
    }

    private func head(_ words: String) -> some View {
        Text(words).font(.tellAnswer).foregroundStyle(Palette.fg).fixedSize(horizontal: false, vertical: true)
    }

    private func note(_ words: String) -> some View {
        Text(words).font(.note).foregroundStyle(Palette.muted)
    }

    private func waitingPill(_ words: String) -> some View {
        HStack(spacing: Metrics.Spacing.s) {
            TellMark(size: 16, color: Palette.muted)
            Text("Your words · waiting").font(.small)
        }
        .foregroundStyle(Palette.muted).padding(.horizontal, Metrics.Spacing.m).frame(height: 32)
        .background(Color.fillTint, in: .capsule)
        .accessibilityLabel("Your words are waiting: \(words)")
    }

    /// The foot, chat style: his words, the microphone, Send; every element keeps its place.
    private var composer: some View {
        DictationField(prompt: "Tell Life…", text: $draft, axis: .vertical, send: submit)
            .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.xs)
            .background(Color.fillTint, in: .rect(cornerRadius: 28))
    }

    private func submit() {
        let words = draft
        draft = ""
        Task { await tell.send(words, screen: router.tellScreen) }
    }
}
