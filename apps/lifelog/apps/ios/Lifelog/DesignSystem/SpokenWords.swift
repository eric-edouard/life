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
    /// Names shown in bold wherever the words say them (a name asked about).
    var emphasis: [String] = []

    /// Each word as shown (with the space after it), made once: `body` runs about 10 times a second while it plays.
    private let pieces: [String]?

    init(
        text: String, words: [[Int64]]?, job: UUID, start: Double, end: Double, style: Style = .box,
        autoplay: Bool = false, emphasis: [String] = []
    ) {
        self.text = text
        self.words = words
        self.job = job
        self.start = start
        self.end = end
        self.style = style
        self.autoplay = autoplay
        self.emphasis = emphasis
        pieces = words?.ranges(in: text).map { ranges in
            ranges.enumerated().map { index, range in
                (text as NSString).substring(with: range) + (index < ranges.count - 1 ? " " : "")
            }
        }
    }

    @Environment(PlaybackStore.self) private var playback
    @State private var isFetching = false
    /// The audio could not be had: the Play shows it, and a tap tries again.
    @State private var failed = false
    @State private var fetch: Task<Void, Never>?

    private var id: String { "\(job)-\(start)" }
    private var isPlaying: Bool { playback.playingID == id }

    var body: some View {
        HStack(alignment: .top, spacing: style == .box ? 14 : 0) {
            if style == .box { playButton }
            spoken
            if style == .inline { playButton }
        }
        .task { if autoplay { begin(at: 0) } }
        .onDisappear {
            fetch?.cancel()
            if isPlaying { playback.stop() }
        }
    }

    @ViewBuilder private var spoken: some View {
        if let pieces, let words, !pieces.isEmpty {
            let spokenIndex = words.spokenIndex(at: Int64((playback.position - start) * 1000))
            // Resting and ended, every word is lit; playing, the words begun.
            let isLit = { (index: Int) in !isPlaying || (spokenIndex.map { index <= $0 } ?? false) }
            FlowLayout {
                // A word's position is its identity: the text is fixed for the view's life.
                ForEach(Array(pieces.enumerated()), id: \.offset) { index, piece in
                    Group {
                        if isEmphasised(piece) { Text(piece).font(.quoteBold) } else { Text(piece) }
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
        } else {
            WholeWords(text).foregroundStyle(Palette.fg)
        }
    }

    private func isEmphasised(_ piece: String) -> Bool {
        let word = piece.trimmingCharacters(in: .whitespaces.union(.punctuationCharacters))
        return emphasis.contains {
            $0.compare(word, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
        }
    }

    private var playButton: some View {
        let size: CGFloat = style == .box ? 48 : 28
        return Button {
            isPlaying ? playback.stop() : begin(at: 0)
        } label: {
            Group {
                if isFetching {
                    ProgressView().tint(style == .box ? Palette.on : Palette.fg)
                } else if failed {
                    Image(systemName: "exclamationmark").font(.system(size: size * 0.36))
                } else {
                    Image(systemName: isPlaying ? "stop.fill" : "play.fill").font(.system(size: size * 0.36))
                }
            }
            .foregroundStyle(failed ? Palette.flag : style == .box ? Palette.on : Palette.fg)
            .frame(width: size, height: size)
            .background(style == .box ? Palette.fg : Color.fillTint, in: .circle)
            .frame(minWidth: Metrics.tapTarget, minHeight: Metrics.tapTarget)
        }
        .buttonStyle(.plain).disabled(isFetching)
        .accessibilityLabel(
            isFetching ? "Loading the recording" : failed ? "Couldn’t load it. Try again" : isPlaying ? "Stop" : "Play")
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
            playback.play(file, from: start + seconds, for: end - start - seconds, id: id)
        }
    }
}
