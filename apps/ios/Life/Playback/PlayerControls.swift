import Library
import SwiftUI
import Timeline

/// The floating glass player of the conversation being read: scrubber, times in Geist Mono,
/// previous and next, 15 s skips and play/pause. It always stands for this conversation: while nothing or another
/// conversation is loaded it shows this one from its start, and play, a skip or the scrubber loads it.
struct ReaderPlayer: View {
    let id: UUID
    let range: Range<CaptureInstant>
    /// Loads this conversation at an instant (its start when `nil`), playing when asked.
    let open: (CaptureInstant?, _ autoplay: Bool) -> Void

    @Environment(PlaybackStore.self) private var playback

    var body: some View {
        let loaded = playback.item?.id == id
        let ready = !loaded || playback.status == .ready
        VStack(spacing: 2) {
            PlayerProgress(range: range, loaded: loaded) { open($0, false) }
                .disabled(!ready)
                .accessibilityIdentifier("player.scrubber")
            HStack {
                Button {
                    playback.advance(-1)
                } label: {
                    Label("Previous conversation", systemImage: "backward.end.fill").tapTarget()
                }
                .foregroundStyle(Palette.textSecondary)
                .disabled(!loaded)
                Spacer(minLength: 0)
                Button {
                    skip(-PlaybackStore.skipMillis, loaded)
                } label: {
                    Label("Back 15 seconds", systemImage: "gobackward.15").tapTarget()
                }
                .accessibilityIdentifier("player.back")
                .font(.title2)
                .disabled(!ready)
                Spacer(minLength: 0)
                playButton(loaded)
                Spacer(minLength: 0)
                Button {
                    skip(PlaybackStore.skipMillis, loaded)
                } label: {
                    Label("Forward 15 seconds", systemImage: "goforward.15").tapTarget()
                }
                .accessibilityIdentifier("player.forward")
                .font(.title2)
                .disabled(!ready)
                Spacer(minLength: 0)
                Button {
                    playback.advance(1)
                } label: {
                    Label("Next conversation", systemImage: "forward.end.fill").tapTarget()
                }
                .foregroundStyle(Palette.textSecondary)
                .disabled(!loaded)
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
            .foregroundStyle(Palette.textPrimary)
            .frame(minHeight: 58)
            if !loaded, playback.isPlaying, let other = playback.item {
                // The mini player hides on a page: say what is playing, and that play switches to this one.
                Text("“\(other.title)” is playing. Play switches to this conversation.")
                    .font(.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 4)
            }
            if loaded, case .unavailable(let reason) = playback.status {
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 4)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 8)
        .floatingGlass(in: .rect(cornerRadius: Metrics.Radius.player))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Player")
    }

    @ViewBuilder private func playButton(_ loaded: Bool) -> some View {
        if loaded, playback.status == .loading {
            ProgressView()
                .frame(width: 58, height: 58)
                .accessibilityLabel("Loading audio")
        } else {
            let playing = loaded && playback.isPlaying
            Button {
                loaded ? playback.togglePlayPause() : open(nil, true)
            } label: {
                Image(systemName: playing ? "pause.fill" : "play.fill")
                    .font(.title2)
                    .foregroundStyle(Palette.textOnRed)
                    .frame(width: 44, height: 44)
                    .contentTransition(.symbolEffect(.replace))
            }
            .primaryGlassButton()
            .buttonBorderShape(.circle)
            .accessibilityLabel(playing ? "Pause" : "Play")
            .accessibilityIdentifier("player.play")
            .disabled(loaded && playback.status != .ready)
        }
    }

    private func skip(_ millis: Int64, _ loaded: Bool) {
        if loaded {
            playback.skip(by: millis)
        } else {
            open(range.lowerBound.advanced(by: max(millis, 0)), false)
        }
    }
}

/// The scrubber. Only this view reads the playing position, so the buttons around it don't redraw ten times a second;
/// the times and what VoiceOver hears change once a second, in `PlayerTimes` and `PositionSlider`. While dragging,
/// the playing position doesn't move the thumb.
private struct PlayerProgress: View {
    let range: Range<CaptureInstant>
    let loaded: Bool
    let seek: (CaptureInstant) -> Void

    @Environment(PlaybackStore.self) private var playback
    @Environment(\.colorSchemeContrast) private var contrast
    @State private var dragging: Double?
    @State private var width: CGFloat = 1

    var body: some View {
        let total = Double(max(range.millis, 1))
        let played = loaded ? playback.position.map { Double(range.lowerBound.distance(to: $0)) / total } ?? 0 : 0
        let fraction = min(max(dragging ?? played, 0), 1)
        let elapsed = Int64(fraction * total)
        VStack(spacing: 4) {
            track(fraction)
                .frame(height: 22)
                .contentShape(.rect)
                .onGeometryChange(for: CGFloat.self) {
                    $0.size.width
                } action: {
                    width = max($0, 1)
                }
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in dragging = value.location.x / width }
                        .onEnded { value in
                            let fraction = min(max(value.location.x / width, 0), 1)
                            seek(range.lowerBound.advanced(by: Int64(fraction * total)))
                            dragging = nil
                        }
                )
            PlayerTimes(elapsed: elapsed / 1000, remaining: (Int64(total) - elapsed) / 1000)
        }
        .accessibilityRepresentation {
            PositionSlider(
                elapsed: elapsed / 1000, total: Int64(total) / 1000, silences: loaded ? playback.gaps.count : 0,
                start: range.lowerBound, seek: seek)
        }
    }

    private func track(_ fraction: Double) -> some View {
        let total = Double(max(range.millis, 1))
        let silences =
            loaded
            ? playback.gaps.map { gap in
                (
                    x: width * Double(range.lowerBound.distance(to: gap.lowerBound)) / total,
                    width: width * Double(gap.lowerBound.distance(to: gap.upperBound)) / total
                )
            } : []
        return ZStack(alignment: .leading) {
            // Stretches without audio are cut out of the line and drawn dotted: silence, not by color alone.
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Palette.textPrimary.opacity(contrast == .increased ? 0.4 : 0.16))
                    .frame(height: 3)
                Capsule()
                    .fill(Palette.textPrimary)
                    .frame(width: width * fraction, height: 3)
                ForEach(silences, id: \.x) { silence in
                    Rectangle().frame(width: silence.width, height: 5).offset(x: silence.x).blendMode(.destinationOut)
                }
            }
            .compositingGroup()
            ForEach(silences, id: \.x) { silence in
                Path { path in
                    path.move(to: CGPoint(x: 0, y: 1))
                    path.addLine(to: CGPoint(x: silence.width, y: 1))
                }
                .stroke(Palette.textTertiary, style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [0.5, 4]))
                .frame(width: silence.width, height: 2)
                .offset(x: silence.x)
            }
            Circle()
                .fill(Palette.liveDot)
                .frame(width: 13, height: 13)
                .background { Circle().fill(Palette.liveDot.opacity(0.22)).padding(-3) }
                .scaleEffect(dragging == nil ? 1 : 1.35)
                .offset(x: width * fraction - 6.5)
                .motion(Motion.standard, value: dragging == nil)
        }
    }
}

/// The time played and the time left, in whole seconds, so they redraw once a second.
private struct PlayerTimes: View {
    let elapsed: Int64
    let remaining: Int64

    var body: some View {
        HStack {
            Text(PlayerClock.string(elapsed * 1000))
            Spacer()
            Text("−" + PlayerClock.string(remaining * 1000))
        }
        .font(.monoSmall)
        .foregroundStyle(Palette.textSecondary)
    }
}

/// What VoiceOver hears and adjusts in place of the scrubber, in whole seconds. Compared without `seek`, which always
/// seeks in the same conversation, so it rebuilds once a second instead of on every position tick.
private struct PositionSlider: View, Equatable {
    let elapsed: Int64
    let total: Int64
    let silences: Int
    let start: CaptureInstant
    let seek: (CaptureInstant) -> Void

    var body: some View {
        // SwiftUI traps when the step exceeds the range (short conversations), so both are clamped.
        let upper = Double(max(total, 1))
        Slider(
            value: Binding(get: { Double(elapsed) }, set: { seek(start.advanced(by: Int64($0 * 1000))) }),
            in: 0...upper, step: min(Double(PlaybackStore.skipMillis) / 1000, upper)
        ) {
            Text("Position")
        }
        .accessibilityValue(
            "\(PlayerClock.spoken(elapsed * 1000)) of \(PlayerClock.spoken(total * 1000))\(silenceNote)")
    }

    /// ", with 2 silent stretches".
    private var silenceNote: String {
        silences == 0
            ? "" : String(AttributedString(localized: ", with ^[\(silences) silent stretch](inflect: true)").characters)
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.elapsed == rhs.elapsed && lhs.total == rhs.total && lhs.silences == rhs.silences && lhs.start == rhs.start
    }
}

/// Play/pause for the compact player above the tab bar.
struct PlayPauseButton: View {
    @Environment(PlaybackStore.self) private var playback

    var body: some View {
        switch playback.status {
        case .loading:
            ProgressView().accessibilityLabel("Loading audio")
        case .ready:
            Button(
                playback.isPlaying ? "Pause" : "Play", systemImage: playback.isPlaying ? "pause.fill" : "play.fill"
            ) { playback.togglePlayPause() }
            .labelStyle(.iconOnly)
            .contentTransition(.symbolEffect(.replace))
        case .unavailable:
            Image(systemName: "speaker.slash").accessibilityLabel("Audio unavailable")
        }
    }
}

/// Positions inside a conversation, counted from its start.
enum PlayerClock {
    /// "4:07", "30:20", "1:05:09".
    static func string(_ millis: Int64) -> String {
        Duration.milliseconds(max(millis, 0) / 1000 * 1000).formatted(
            .time(pattern: millis >= 3_600_000 ? .hourMinuteSecond : .minuteSecond))
    }

    /// "4 minutes, 7 seconds", for VoiceOver.
    static func spoken(_ millis: Int64) -> String {
        Duration.milliseconds(max(millis, 0) / 1000 * 1000).formatted(
            .units(allowed: [.hours, .minutes, .seconds], width: .wide))
    }
}
