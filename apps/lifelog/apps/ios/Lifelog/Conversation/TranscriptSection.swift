import Library
import SwiftUI
import Timeline
import UIKit

/// One row of the transcript: whatever the block, a single view, so the list derives every row's identity from the
/// block's id alone and never builds a row it doesn't show. Each passage's own start is its seek target, so selecting
/// text never seeks.
struct TranscriptBlockView: View {
    let block: TranscriptBlock
    let store: ConversationStore
    let reading: ReadAlong
    /// The conversation's start, for the times beside passages.
    let origin: CaptureInstant
    /// The one highlight, which moves from passage to passage.
    let highlight: Namespace.ID

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch block {
            case .passage(let line):
                Passage(
                    store: store, line: line, name: line.speaker.displayName, isPerson: store.isPerson(line),
                    isWaiting: store.speakerWaiting(line), offset: origin.distance(to: line.start),
                    reading: reading, highlight: highlight)
            case .photos(let photos):
                PhotoStrip(photos: photos, origin: origin, store: store)
            case .chapter(let chapter, let line):
                ChapterHeading(
                    store: store, reading: reading, title: chapter.title ?? "Chapter", start: line,
                    offset: origin.distance(to: line))
            case .splitSuggestion(let at, _):
                SplitSuggestion(store: store, at: at, offset: origin.distance(to: CaptureInstant(at)))
            }
        }
    }
}

/// A chapter's title where its first turn starts: quiet, like a section heading. Tapping it plays from there.
private struct ChapterHeading: View {
    let store: ConversationStore
    let reading: ReadAlong
    let title: String
    let start: CaptureInstant
    /// Milliseconds from the conversation's start.
    let offset: Int64

    @Environment(PlaybackStore.self) private var playback

    var body: some View {
        Button {
            reading.play(store, from: start, on: playback)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(PlayerClock.string(offset))
                    .font(.monoSmall)
                    .foregroundStyle(Palette.textTertiary)
                    .fixedSize()
            }
            .padding(.horizontal, 12)
            .padding(.top, 18)
            .padding(.bottom, 2)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Chapter: \(title), \(PlayerClock.spoken(offset))")
        .accessibilityAddTraits(.isHeader)
        .accessibilityHint("Plays from here")
        .accessibilityIdentifier("transcript.chapter")
    }
}

/// "Split here?" where the summary run was unsure a new conversation starts: a dashed line between the two passages,
/// and the owner's answer. Split makes the rest a new conversation; Keep together makes the suggestion go. A split the
/// owner made that the server doesn't have yet shows as the same line, waiting to sync.
private struct SplitSuggestion: View {
    let store: ConversationStore
    let at: Date
    /// Milliseconds from the conversation's start.
    let offset: Int64

    @State private var answering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Line()
                .stroke(Palette.textTertiary, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .frame(height: 1)
                .accessibilityHidden(true)
            if store.waitingSplits.contains(at) {
                Label("Splits here · waiting to sync", systemImage: "arrow.triangle.2.circlepath")
                    .labelStyle(.decorativeIcon)
                    .font(.footnote)
                    .foregroundStyle(Palette.textTertiary)
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                        question; Spacer(minLength: 4); answers
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        question; answers
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .disabled(answering)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("transcript.splitSuggestion")
    }

    private var question: some View {
        Label("Split here? · \(PlayerClock.string(offset))", systemImage: "scissors")
            .labelStyle(.decorativeIcon)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Palette.textSecondary)
            .accessibilityLabel("Split here? At \(PlayerClock.spoken(offset))")
    }

    private var answers: some View {
        HStack(spacing: 8) {
            Button("Keep together") { answer(split: false) }
                .buttonStyle(.glass)
                .accessibilityIdentifier("transcript.splitSuggestion.keep")
            Button("Split") { answer(split: true) }
                .primaryGlassButton()
                .accessibilityHint("Everything from here on becomes a new conversation. No audio is lost.")
                .accessibilityIdentifier("transcript.splitSuggestion.split")
        }
        .font(.footnote)
    }

    private func answer(split: Bool) {
        answering = true
        Task {
            await store.answerSplit(at: at, split: split)
            answering = false
        }
    }
}

/// A horizontal line through the middle of its frame.
nonisolated private struct Line: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        }
    }
}

/// Above the transcript: how this conversation's edges came to be, with Undo: "Split by AI", "Split by you" or
/// "Merged by you".
struct SplitNotes: View {
    let store: ConversationStore

    var body: some View {
        if let edit = store.undoableEdit {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Label(
                    Self.sentence(edit), systemImage: edit.kind == .merge ? "arrow.triangle.merge" : "scissors"
                )
                .foregroundStyle(Palette.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    Task { await store.undoEdge() }
                } label: {
                    // The words stay small; the tap target is 44 pt.
                    Text("Undo").fontWeight(.semibold).tapTarget()
                }
                .accessibilityHint(
                    edit.kind == .merge
                        ? "Splits it back where it was"
                        : store.conversation?.endEdit == edit.id
                            ? "Puts this conversation back with the one after it"
                            : "Puts this conversation back with the one before it"
                )
                .accessibilityIdentifier("conversation.split.undo")
            }
            .font(.footnote)
            .padding(.leading, 12)
            .padding(.trailing, 4)
            .card(radius: Metrics.Radius.passage)
            .padding(.vertical, 6)
        }
    }

    static func sentence(_ edit: CachedEdit) -> String {
        switch (edit.kind, edit.source) {
        case (.merge, _): "Merged by you"
        case (_, .ai): "Split by AI"
        default: "Split by you"
        }
    }
}

/// One turn: the speaker's name small and spaced, the words in reading type. Tapping the words or the time beside the
/// name plays from the turn's start; the name opens the pills that say who speaks (`WhoPills`). Any range of words can be selected and copied;
/// selecting stops the page from following and never seeks.
struct Passage: View {
    enum Phase {
        case upcoming
        case spoken
        case past
    }

    let store: ConversationStore
    let line: CachedTurn
    let name: String
    let isPerson: Bool
    /// An answer about this voice waits for the server.
    let isWaiting: Bool
    /// Milliseconds from the conversation's start.
    let offset: Int64
    let reading: ReadAlong
    /// The one highlight, which moves from passage to passage.
    let highlight: Namespace.ID

    @Environment(PlaybackStore.self) private var playback
    /// The pills name every passage of this voice, not only this one.
    @State private var everywhere = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            passage
            if store.naming?.start == line.start { pills }
        }
        // Drawn beneath its neighbours, so the highlight glides under their words, never over them.
        .zIndex(reading.state(of: line.start) == .spoken ? -1 : 0)
    }

    private var passage: some View {
        let state = reading.state(of: line.start)
        return VStack(alignment: .leading, spacing: 4) {
            speaker(state)
            words(state)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background {
            if state == .spoken {
                RoundedRectangle(cornerRadius: Metrics.Radius.passage)
                    .fill(Palette.surface2)
                    .matchedGeometryEffect(id: "spoken", in: highlight)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name)\(isWaiting ? ", waiting to sync" : ""), \(PlayerClock.spoken(offset))")
        .accessibilityValue(line.speaker.source == .inferred ? "Inferred speaker. " + line.text : line.text)
        .accessibilityHint("Plays from here")
        .accessibilityAddTraits(state == .spoken ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("passage")
        .accessibilityAction { play() }
        .accessibilityAction(named: "Play from here", play)
        .accessibilityAction(named: "Change speaker", editSpeaker)
        .accessibilityAction(named: "Copy passage") { UIPasteboard.general.string = line.text }
        .accessibilityAction(named: "Split conversation here") { store.splitting = line }
    }

    private func speaker(_ state: Phase) -> some View {
        let color: Color =
            if state == .spoken { Palette.redText } else if isPerson { Palette.textSecondary } else {
                Palette.textTertiary
            }
        return HStack(spacing: 6) {
            Button(action: editSpeaker) {
                HStack(spacing: 6) {
                    if state == .spoken, playback.isPlaying {
                        Image(systemName: "play.fill").imageScale(.small).accessibilityHidden(true)
                    }
                    Text(name)
                        .font(.caption2.weight(.semibold))
                        .tracking(0.9)
                        .textCase(.uppercase)
                        .lineLimit(2)
                    if line.speaker.source == .inferred {
                        Text("Inferred")
                            .font(.caption2)
                    }
                    if isWaiting {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .imageScale(.small)
                            .accessibilityHidden(true)
                    }
                }
                .foregroundStyle(color)
                .padding(.vertical, 4)
                .contentShape(.rect)
            }
            .accessibilityIdentifier("passage.speaker")
            // The explicit way to play from the turn's start. Never squeezed: at large sizes the name gives way.
            Button(action: play) {
                Text(PlayerClock.string(offset))
                    .font(.monoSmall)
                    .foregroundStyle(Palette.textTertiary)
                    .fixedSize()
                    .padding(.vertical, 4)
                    .contentShape(.rect)
            }
        }
        .buttonStyle(.plain)
    }

    private func words(_ state: Phase) -> some View {
        let color: Color =
            switch state {
            case .spoken: Palette.textPrimary
            case .past: Palette.textSecondary
            case .upcoming: Palette.textBody
            }
        return PassageText(
            text: line.text, color: color, lit: state == .spoken ? reading.word : nil,
            tap: { reading.play(store, from: line.start, on: playback) }, select: { reading.following = false })
    }

    private func play() { reading.play(store, from: line.start, on: playback) }

    /// Toggles the pills under this passage.
    private func editSpeaker() { store.naming = store.naming?.start == line.start ? nil : line }

    private var pills: some View {
        let current = store.people.first { $0.id == line.speaker.personId }.map(WhoPills.pick)
        let shown = [store.people.first(where: \.isOwner).map(WhoPills.pick), current].compactMap(\.self)
        let suggested = (shown + store.recent).reduce(into: [WhoPills.Pick]()) { all, pick in
            if !all.contains(pick) { all.append(pick) }
        }
        return VStack(alignment: .leading, spacing: 6) {
            if let inference = line.speaker.inference, line.speaker.source == .inferred {
                Text(inference.basis == .twoPerson ? "Inferred from two participants" : "Inferred from context")
                    .font(.caption)
                    .foregroundStyle(Palette.textSecondary)
                ForEach(inference.evidence.indices, id: \.self) { index in
                    Text(inference.evidence[index].quote)
                        .font(.caption)
                        .foregroundStyle(Palette.textTertiary)
                }
            }
            WhoPills(
                people: store.people, suggested: suggested, picked: current,
                everywhere: line.speaker.label == nil ? nil : $everywhere,
                split: store.conversation?.isImported == true ? nil : { store.splitting = line }
            ) { pick in
                Task { await store.name(line, as: pick, everywhere: everywhere) }
            }
        }
        .padding([.horizontal, .bottom], 12)
    }
}

extension View {
    /// A soft light sweeping across, for labels about to change (speakers being recognized). Off under Reduce
    /// Motion; always pair it with words saying what is happening.
    func shimmering(_ active: Bool) -> some View { modifier(Shimmer(active: active)) }
}

private struct Shimmer: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if active, !reduceMotion {
            content.keyframeAnimator(initialValue: -0.5, repeating: true) { content, phase in
                content.mask {
                    LinearGradient(
                        stops: [
                            .init(color: .black.opacity(0.4), location: 0),
                            .init(color: .black, location: 0.5),
                            .init(color: .black.opacity(0.4), location: 1),
                        ],
                        startPoint: UnitPoint(x: phase - 0.5, y: 0.5), endPoint: UnitPoint(x: phase + 0.5, y: 0.5))
                }
            } keyframes: { _ in
                LinearKeyframe(1.5, duration: 1.6)
            }
        } else {
            content
        }
    }
}
