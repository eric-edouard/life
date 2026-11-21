import Library
import SwiftUI

/// Words that come from a recording, with their Play: while it plays, the words said so far and the one being said are
/// `fg` and the words to come `muted`, in colour only so no line moves. Tap a word to play from it. One recording plays
/// at a time (`PlaybackStore`), and the one that leaves the screen stops it. The host sets the font and the box.
struct SpokenWords: View {
    enum Style {
        /// A 48 round Play at the left of the words.
        case box
        /// A 28 Play (in a 44 hit area) at the right of the words.
        case inline
        /// Like `inline`, with a 48 Play, and the words on one line, cut with an ellipsis (a bulk card's voice row).
        case line
    }

    /// The words and when each is said (contract `TimedWords`); without them the text is shown whole.
    let text: String
    let words: [[Int64]]?
    /// The recording's span: the job whose audio plays, from `start` to `end` seconds.
    let job: UUID
    let start: Double
    let end: Double
    var style = Style.box
    /// Plays from the start as it appears (the next clip of a row of clips).
    var autoplay = false
    /// A line above the words, with the inline Play at its right end (who said it, and when).
    var caption: String?
    /// Told when the recording plays to its end (not when it is stopped).
    var onEnded: (() -> Void)?

    /// Each word as shown (with the space after it) and whether it is part of a name, made once: `body` runs about
    /// 10 times a second while it plays.
    private let pieces: [(text: String, isBold: Bool)]?

    init(
        text: String, words: [[Int64]]?, job: UUID, start: Double, end: Double, style: Style = .box,
        autoplay: Bool = false, emphasis: [String] = [], caption: String? = nil,
        onEnded: (() -> Void)? = nil
    ) {
        self.text = text
        self.words = words
        self.job = job
        self.start = start
        self.end = end
        self.style = style
        self.autoplay = autoplay
        self.caption = caption
        self.onEnded = onEnded
        let names = emphasis.isEmpty ? [] : text.ranges(ofNames: emphasis).map { NSRange($0, in: text) }
        pieces = words?.ranges(in: text).map { ranges in
            ranges.enumerated().map { index, range in
                (
                    (index == 0 ? "“" : "") + (text as NSString).substring(with: range)
                        + (index < ranges.count - 1 ? " " : "”"),
                    names.contains { NSIntersectionRange($0, range).length > 0 }
                )
            }
        }
    }

    @Environment(PlaybackStore.self) private var playback
    @State private var isFetching = false
    /// The audio could not be had: the Play shows it, and a tap tries again.
    @State private var failed = false
    @State private var fetch: Task<Void, Never>?

    private var id: String { "\(job)-\(start)" }
    /// This recording is the one loaded (playing or paused): its words are split where it is.
    private var isCurrent: Bool { playback.playingID == id }
    private var isPlaying: Bool { isCurrent && playback.isPlaying }

    var body: some View {
        Group {
            if style == .inline, let caption {
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                    HStack(spacing: 0) {
                        Text(caption).font(.small).foregroundStyle(Palette.muted)
                        Spacer(minLength: 0)
                        playButton
                    }
                    spoken
                }
            } else {
                HStack(alignment: .top, spacing: style == .box ? 14 : 0) {
                    if style == .box { playButton }
                    spoken
                    if style != .box { playButton }
                }
            }
        }
        .task { if autoplay { begin(at: 0) } }
        .onDisappear {
            fetch?.cancel()
            if isCurrent { playback.stop() }
        }
    }

    @ViewBuilder private var spoken: some View {
        if let pieces, let words, !pieces.isEmpty {
            let spokenIndex = words.spokenIndex(at: Int64((playback.position - start) * 1000))
            // Resting and ended, every word is lit; playing or paused, the words begun.
            let isLit = { (index: Int) in !isCurrent || (spokenIndex.map { index <= $0 } ?? false) }
            if style == .line {
                pieces.enumerated().reduce(Text("")) { line, item in
                    line + Text(item.element.text).foregroundStyle(isLit(item.offset) ? Palette.fg : Palette.muted)
                }
                .lineLimit(1).accessibilityLabel(text)
            } else {
                FlowLayout {
                    // A word's position is its identity: the text is fixed for the view's life.
                    ForEach(Array(pieces.enumerated()), id: \.offset) { index, piece in
                        Group {
                            if piece.isBold { Text(piece.text).font(.quoteBold) } else { Text(piece.text) }
                        }
                        .lineLimit(1)
                        .minimumScaleFactor(0.3)
                        .foregroundStyle(isLit(index) ? Palette.fg : Palette.muted)
                        .motion(.easeOut(duration: 0.12), value: isLit(index))
                        .contentShape(.rect)
                        .onTapGesture { begin(at: Double(words[index][0]) / 1000) }
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(text)
            }
        } else if style == .line {
            Text("“\(text)”").lineLimit(1).foregroundStyle(Palette.fg)
        } else {
            WholeWords("“\(text)”").foregroundStyle(Palette.fg)
        }
    }

    private var playButton: some View {
        let size: CGFloat = style == .inline ? 28 : 48
        return Button {
            if isPlaying { playback.pause() } else if isCurrent { playback.resume() } else { begin(at: 0) }
        } label: {
            Group {
                if isFetching {
                    Spinner(size: style == .inline ? .small : .regular)
                } else if failed {
                    Image(systemName: "exclamationmark").font(.system(size: size * 0.36))
                } else {
                    Image(systemName: isPlaying ? "pause.fill" : "play.fill").font(.system(size: size * 0.36))
                }
            }
            .foregroundStyle(failed ? Palette.flag : style == .box ? Palette.on : Palette.fg)
            .frame(width: size, height: size)
            .background(style == .box ? Palette.fg : Color.fillTint, in: .circle)
            .frame(minWidth: Metrics.tapTarget, minHeight: Metrics.tapTarget)
        }
        .buttonStyle(.plain).disabled(isFetching)
        .accessibilityLabel(
            isFetching ? "Loading the recording" : failed ? "Couldn’t load it. Try again" : isPlaying ? "Pause" : "Play"
        )
    }

    /// Plays from `seconds` into the span, fetching the audio first when the phone lacks it.
    private func begin(at seconds: Double) {
        guard !isFetching else { return }
        isFetching = true
        failed = false
        fetch = Task {
            let file = await ClipAudio.file(job)
            isFetching = false
            guard !Task.isCancelled else { return }
            guard let file else { return failed = true }
            playback.play(file, from: start + seconds, for: end - start - seconds, id: id, onEnd: onEnded)
        }
    }
}
