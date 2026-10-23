import ServerAPI
import SwiftUI

/// Processing the owner can act on, as calm cards: not paired with a server, a switch off, conversations waiting for
/// credits or for the Mac. Offline and uploads
/// are the status's, at the top of every tab. Nothing when all is well.
struct TranscriptionCards: View {
    let facts: TranscriptionFacts

    var body: some View {
        if !facts.isPaired {
            AttentionCard(
                id: "pendant.card.pairing", title: "Not transcribing", systemImage: "key",
                detail:
                    "This iPhone isn't paired with a server, so nothing is sent. Scan the pairing code on your Mac with the Camera. Recording goes on without it."
            )
        }
        if facts.switches?.transcription == false {
            AttentionCard(
                id: "pendant.card.transcriptionOff", title: "Transcription is off", systemImage: "pause.circle",
                detail:
                    "Recorded audio waits on the server. Recording and sync go on, and it's transcribed once you turn it back on in Settings."
            )
        }
        if facts.switches?.ai == false {
            AttentionCard(
                id: "pendant.card.aiOff", title: "AI is off", systemImage: "pause.circle",
                detail:
                    "Summaries, titles and search by meaning wait until you turn it back on in Settings. Search still finds words."
            )
        }
        if let count = facts.waiting[.creditsOut] {
            AttentionCard(
                id: "pendant.card.credits", title: "ElevenLabs credits are out", systemImage: "creditcard",
                detail:
                    "\(conversationCount(count)) wait for words. Top up ElevenLabs and they go on their own."
            )
        }
        // Summaries, and audio the Mac hasn't checked for dictation yet. With AI off, its own card says why
        // summaries wait.
        if let count = facts.waiting[.macAway], facts.switches?.ai != false {
            AttentionCard(
                id: "pendant.card.macAway", title: "\(conversationCount(count)) waiting for your Mac",
                systemImage: "laptopcomputer", detail: macDetail)
        }
    }

    private var macDetail: String {
        switch facts.macLlm?.reason {
        case .auth?:
            facts.switches?.engine == .codex
                ? "Your Mac needs a ChatGPT login: Voice Host → Settings → Summaries."
                : "Your Mac needs a Claude login: Voice Host → Settings → Summaries."
        case .limit?: "Your subscription limit is reached; it resumes when the limit resets."
        default: "They go on once your Mac is awake and online."
        }
    }

}

#if DEBUG
    private func cards(_ facts: TranscriptionFacts) -> some View {
        ScrollView {
            VStack(spacing: 12) { TranscriptionCards(facts: facts) }
                .padding(16)
        }
        .background(Palette.ground)
        .preferredColorScheme(.dark)
    }

    #Preview("Waiting for the Mac") { cards(TranscriptionFacts(waiting: [.macAway: 7])) }
    #Preview("Mac at its plan limit, credits out") {
        cards(
            TranscriptionFacts(waiting: [.macAway: 12, .creditsOut: 3], macLlm: .init(able: false, reason: .limit)))
    }
    #Preview("Not paired, switches off") {
        cards(
            TranscriptionFacts(
                isPaired: false, switches: .init(transcription: false, ai: false, openAppAfterMinutes: 0)))
    }
#endif
