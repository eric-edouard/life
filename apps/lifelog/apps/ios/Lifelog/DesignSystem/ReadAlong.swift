import Library
import LifeConnector
import SwiftUI

/// Lays views out left to right, starting a new line when the next one doesn't fit (words, chips).
struct FlowLayout: Layout {
    var spacing: CGFloat = 0

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let frames = frames(width: proposal.width ?? .infinity, subviews: subviews)
        return CGSize(width: proposal.width ?? frames.map(\.maxX).max() ?? 0, height: frames.map(\.maxY).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, frame) in zip(subviews, frames(width: bounds.width, subviews: subviews)) {
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(frame.size))
        }
    }

    private func frames(width: CGFloat, subviews: Subviews) -> [CGRect] {
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        for subview in subviews {
            var size = subview.sizeThatFits(.unspecified)
            if size.width > width { size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil)) }
            if x > 0, x + size.width > width {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        return frames
    }
}

/// A clip of what was said, only its words with a Play (owner, 26 Nov 2026: "the clip is only its words read along").
/// While it plays, the words said so far are `fg` and the ones to come `muted`: colour only, so no line moves. A tap on
/// a word plays from it. Without word timings the words show whole; without audio there is no Play.
struct ReadAlong: View {
    let clip: Check.Clip

    @Environment(PlaybackStore.self) private var playback
    @State private var isFetching = false
    @State private var failed = false
    @State private var fetch: Task<Void, Never>?

    private var job: UUID? { clip.audio.flatMap { UUID(uuidString: $0.jobId) } }
    private var id: String { "\(clip.audio?.jobId ?? "")-\(clip.audio?.start ?? 0)" }
    private var isCurrent: Bool { playback.playingID == id }
    private var isPlaying: Bool { isCurrent && playback.isPlaying }

    var body: some View {
        HStack(alignment: .top, spacing: Metrics.Spacing.m) {
            if job != nil { playButton }
            words
        }
        .onDisappear {
            fetch?.cancel()
            if isCurrent { playback.stop() }
        }
    }

    @ViewBuilder private var words: some View {
        let text = clip.text
        if let timed = clip.words, let ranges = timed.ranges(in: text), !ranges.isEmpty {
            let spoken = timed.spokenIndex(at: Int64((playback.heardPosition - (clip.audio?.start ?? 0)) * 1000))
            // Dim until played, then lit as each word is said (voice is read, not drawn).
            let isLit = { (index: Int) in isCurrent && (spoken.map { index <= $0 } ?? false) }
            FlowLayout {
                ForEach(Array(ranges.enumerated()), id: \.offset) { index, range in
                    Text((text as NSString).substring(with: range) + (index < ranges.count - 1 ? " " : ""))
                        .font(.body15).lineLimit(1)
                        .foregroundStyle(isLit(index) ? Palette.fg : Palette.muted)
                        .motion(Motion.standard, value: isLit(index))
                        .contentShape(.rect)
                        .onTapGesture { if job != nil { begin(at: Double(timed[index][0]) / 1000) } }
                }
            }
            .padding(.top, Metrics.Spacing.s).accessibilityElement(children: .ignore).accessibilityLabel(text)
        } else {
            // No timings: dim until played, then whole.
            Text(text).font(.body15).foregroundStyle(isCurrent ? Palette.fg : Palette.muted)
                .padding(.top, Metrics.Spacing.s).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var playButton: some View {
        Button {
            if isPlaying { playback.pause() } else if isCurrent { playback.resume() } else { begin(at: 0) }
        } label: {
            Group {
                if isFetching {
                    Spinner(size: .small)
                } else if failed {
                    Image(systemName: "exclamationmark").font(.lineStrong)
                } else {
                    Image(systemName: isPlaying ? "pause.fill" : "play.fill").font(.lineStrong)
                }
            }
            .foregroundStyle(failed ? Palette.flag : Palette.fg)
            .frame(width: 24, height: 36)
            .frame(minWidth: Metrics.tapTarget, minHeight: Metrics.tapTarget)
        }
        .buttonStyle(.plain).disabled(isFetching)
        .accessibilityLabel(
            isFetching ? "Loading the recording" : failed ? "Couldn’t load it. Try again" : isPlaying ? "Pause" : "Play"
        )
    }

    private func begin(at seconds: Double) {
        guard !isFetching, let job, let audio = clip.audio else { return }
        isFetching = true
        failed = false
        fetch = Task {
            let file = await ClipAudio.file(job)
            isFetching = false
            guard !Task.isCancelled else { return }
            guard let file,
                playback.play(file, from: audio.start + seconds, for: audio.end - audio.start - seconds, id: id)
            else {
                failed = true
                return
            }
        }
    }
}
