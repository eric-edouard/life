import Library
import SwiftUI

/// Where the words stand (contract "App states"), in plain sentences: a designed placeholder instead of a transcript,
/// or a note above one while more words come. Audio plays in every state.
struct TranscriptStatus: View {
    let store: ConversationStore

    var body: some View {
        if store.lines.isEmpty {
            placeholder
        } else if [.transcribing, .notUploaded].contains(store.state) {
            StatusCard(
                title: "More words on their way", glyph: .working,
                detail: "These are the words so far. The rest show as the server transcribes them.")
        }
    }

    @ViewBuilder private var placeholder: some View {
        switch store.state {
        case .notUploaded:
            StatusCard(
                title: "Not uploaded yet", glyph: .waiting,
                detail: "It plays from this phone. It goes to the server with the next sync, and its words follow.")
        case .uploaded:
            VStack(alignment: .leading, spacing: 18) {
                StatusCard(
                    title: "Uploaded", glyph: .waiting, detail: "The server has the audio. Words in a few minutes.")
                SkeletonPassages()
            }
        case .transcribing:
            VStack(alignment: .leading, spacing: 18) {
                StatusCard(title: "Transcribing", glyph: .working, detail: "Words in a few minutes.")
                SkeletonPassages()
            }
        case .failed:
            StatusCard(
                title: "Couldn’t transcribe", glyph: .waiting,
                detail: "Transcription gave up on this audio after several tries. It still plays from this phone.")
        case .transcribed, .summarized:
            Text("No speech was transcribed in this conversation.")
                .font(.placeholderTitle)
                .foregroundStyle(Palette.textBody)
                .padding(.horizontal, 12)
                .padding(.vertical, 20)
        }
    }
}

/// A rounded note: a badge saying the state in words with a glyph, and an explanation.
private struct StatusCard: View {
    let title: String
    let glyph: ProcessingBadge.Glyph
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ProcessingBadge(title: title, glyph: glyph)
            if let detail {
                Text(detail).font(.subheadline).foregroundStyle(Palette.textSecondary)
            }
        }
        .padding(Metrics.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(radius: Metrics.Radius.passage)
        .padding(.vertical, 6)
    }
}

/// Grey passages standing in for text on its way; they shimmer unless Reduce Motion is on.
private struct SkeletonPassages: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            ForEach([0.92, 0.7, 0.85, 0.55], id: \.self) { width in
                VStack(alignment: .leading, spacing: 8) {
                    Capsule().frame(width: 64, height: 8)
                    Capsule().frame(height: 12)
                    Capsule().frame(height: 12).containerRelativeFrame(.horizontal) { length, _ in length * width }
                }
            }
        }
        .foregroundStyle(Palette.surface3)
        .shimmering(true)
        .padding(.horizontal, 12)
        .accessibilityHidden(true)
    }
}
