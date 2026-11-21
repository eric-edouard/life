import AVFAudio
import Accessibility
import ServerAPI
import SwiftUI

/// Every free-text field of the app: typing, and the one microphone (decision 87; the dictation spec of 20 Nov). A tap
/// on the microphone starts a run, a tap pauses it and a tap goes on; a hold records while held. At each pause the
/// run's words land where the caret was. While listening, a one-line field's text line holds the cancel, the time and
/// the stream; a tall field takes them on a line under its text. Heard instantly (his `dictationHeard` switch), the
/// words show as they come, fading in (`LiveWordsText`): in a tall field's text at the caret, in a one-line field's line
/// in place of the stream. A field's font, colour, line limit, padding and fill stay its caller's.
struct DictationField: View {
    let prompt: String
    /// What VoiceOver calls the field, when its prompt doesn't say it (a row's label).
    var label: String?
    @Binding var text: String
    var axis = Axis.horizontal
    var focused: FocusState<Bool>.Binding?
    /// A field with a Send: Send sits right of the microphone, and a swipe up from it, or a hold slid up its track,
    /// sends once the words landed. While recording, Send dissolves into a "Swipe up to send" hint on the microphone.
    /// Every field with a single submit passes one (Ask Life, a matter's goal or next step, the new agent's goal) in
    /// place of its own Save or Start button; a card's answers stay buttons.
    var send: (() -> Void)?

    @Environment(\.library) private var library
    @Environment(SyncStore.self) private var sync
    @Environment(\.openURL) private var openURL
    @State private var dictation = Dictation(
        begin: { _ in throw Dictation.StartFailure.notStarted },
        words: { try await ServerClient.production.dictationWords($0) },
        refused: { AVAudioApplication.shared.recordPermission == .denied })
    @State private var selection: TextSelection?
    /// The text and caret when the run started: the keyboard goes away while he speaks, and the words land there
    /// (at the end when the text changed since).
    @State private var caret: (text: String, selection: TextSelection?)?
    /// How far up his thumb is from the microphone while he holds, nil when he isn't holding (the track).
    @State private var rise: CGFloat?
    private let live = LiveWords.shared

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            if let problem = dictation.problem { ProblemLine(problem: problem) { fix(problem) }.appears() }
            HStack(alignment: axis == .vertical ? .bottom : .center, spacing: Metrics.Spacing.s) {
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                    let isOneLineBusy = axis == .horizontal && dictation.phase != .rest
                    let isTallLive = axis == .vertical && isLive
                    // Both stay in the stack: the field keeps its height, the live text grows it as words come.
                    ZStack(alignment: .topLeading) {
                        field.opacity(isOneLineBusy || isTallLive ? 0 : 1)
                        if isTallLive {
                            let (head, tail) = DictatedText.parts(in: text, at: keptCaret)
                            // The caller's line limit holds; past it, the newest words stay in sight.
                            LiveWordsText(head: head, words: live.words, tail: tail).truncationMode(.head)
                        }
                    }
                    .overlay(alignment: .leading) {
                        if isOneLineBusy { ListeningLine(dictation: dictation, live: isLive ? live : nil) }
                    }
                    if axis == .vertical, dictation.phase != .rest {
                        ListeningLine(dictation: dictation, live: nil).appears()
                    }
                }
                DictationMic(dictation: dictation, canSend: send != nil, rise: $rise, start: start)
                    .overlay(alignment: .bottom) { if let rise { SendTrack(rise: rise) } }
                    .overlay(alignment: .top) {
                        if send != nil, isRecording, rise == nil { SwipeHint().offset(y: -Metrics.tapTarget) }
                    }
                if let send {
                    SendButton(isHidden: isRecording, isLit: hasWords && dictation.phase == .rest, send: send)
                }
            }
        }
        .motion(Motion.standard, value: dictation.phase)
        .motion(Motion.standard, value: dictation.problem)
        .sensoryFeedback(trigger: dictation.phase) { old, new in
            switch (old, new) {
            case (.rest, .starting): .impact(weight: .medium)
            case (.starting, .writing), (.listening, .writing): .impact(weight: .light)
            default: nil
            }
        }
        .sensoryFeedback(.success, trigger: dictation.landed)
        .sensoryFeedback(.error, trigger: dictation.problem) { _, new in new != nil }
        .onAppear { dictation.begin = DictationCapture.run(library: library, sync: sync) }
        .onDisappear { dictation.cancel() }
        .onChange(of: dictation.landed) { _, landed in
            if let landed { land(landed) }
        }
    }

    private var isRecording: Bool { dictation.phase == .starting || dictation.phase == .listening }
    /// This field's run is heard instantly and has words (a stream that failed keeps them until the Mac's land): only
    /// one microphone runs at a time.
    private var isLive: Bool { dictation.phase != .rest && !live.words.isEmpty }
    private var hasWords: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    @ViewBuilder private var field: some View {
        let field = TextField(prompt, text: $text, selection: $selection, axis: axis).tint(Palette.fg)
            .accessibilityLabel(label ?? prompt)
        if let focused { field.focused(focused) } else { field }
    }

    /// A run from rest.
    private func start() {
        keepCaret()
        dictation.start()
    }

    /// Keeps the caret for the words, and puts the keyboard away while he speaks: the words don't bring it back.
    private func keepCaret() {
        caret = (text, selection)
        focused?.wrappedValue = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    /// The text and caret when the run started, as `DictatedText` reads them.
    private var keptCaret: (text: String, selection: Range<String.Index>?)? {
        var picked: Range<String.Index>?
        if case .selection(let range)? = caret?.selection?.indices { picked = range }
        return caret.map { (text: $0.text, selection: picked) }
    }

    /// The words at the caret he left, then, on a swipe up, the Send, which reads the text with them.
    private func land(_ landed: Dictation.Landed) {
        live.clear()
        guard let landing = DictatedText.inserting(landed.words, into: text, at: keptCaret) else { return }
        text = landing.text
        selection = TextSelection(insertionPoint: landing.caret)
        AccessibilityNotification.Announcement(landed.words).post()
        if landed.sends { send?() }
    }

    private func fix(_ problem: Dictation.Problem) {
        if problem == .notWritten { keepCaret() }  // Speak again starts a run
        dictation.fix {
            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        }
    }
}

/// Why the last press brought no words, on the field's top line in `flag`, and its quiet link when one fixes it.
private struct ProblemLine: View {
    let problem: Dictation.Problem
    let fix: () -> Void

    var body: some View {
        HStack(spacing: Metrics.Spacing.s) {
            Text(problem.line).font(.small).foregroundStyle(Palette.flag)
            if let link = problem.fix { QuietChip(link.title, symbol: link.symbol, action: fix) }
        }
    }
}

/// The microphone: a 36 disc. At rest, the microphone (slashed and muted when refused); recording, an `fg` disc with
/// a pause glyph and a soft `ai` pulse, grown to 64 while held; writing, the app's spinner. A tap starts, pauses or
/// goes on; a hold records while held and letting go pauses; with a Send, a swipe up sends.
private struct DictationMic: View {
    let dictation: Dictation
    let canSend: Bool
    /// How far up his thumb is while he holds (for the field's track); nil when he isn't holding.
    @Binding var rise: CGFloat?
    /// Starts a run from rest (the field keeps its caret first).
    let start: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Whether his finger is down; false again once it is up, or once the system took the gesture away.
    @GestureState private var isDown = false
    /// The phase when his finger went down, and since when: a quick press is a tap, a long one a hold.
    @State private var press: (wasRecording: Bool, at: Date)?
    @State private var isHolding = false
    @State private var pulses = false

    private static let holdAfter = 0.3
    private var isRecording: Bool { dictation.phase == .starting || dictation.phase == .listening }

    var body: some View {
        ZStack {
            if isRecording && !reduceMotion {
                Circle().fill(Palette.ai.opacity(pulses ? 0 : 0.35)).scaleEffect(pulses ? 1.5 : 1)
                    .animation(.easeOut(duration: 1.2).repeatForever(autoreverses: false), value: pulses)
                    .onAppear { pulses = true }
                    .onDisappear { pulses = false }
            }
            Circle().fill(isRecording ? Palette.fg : Color.fillTint)
            glyph
        }
        .frame(width: isHolding ? 64 : 36, height: isHolding ? 64 : 36)
        .frame(minWidth: Metrics.tapTarget, minHeight: Metrics.tapTarget)
        .contentShape(.rect)
        .animation(reduceMotion ? nil : .spring(duration: 0.22), value: isHolding)
        .gesture(
            DragGesture(minimumDistance: 0).updating($isDown) { _, isDown, _ in isDown = true }
                .onChanged { value in
                    if canSend, isHolding { rise = max(0, -value.translation.height) }
                }
                .onEnded { value in letGo(swipedUp: value.translation.height < -Metrics.tapTarget) }
        )
        // A gesture the system takes away (a scroll, an alert) never ends; its state resets all the same, after which
        // a press `onEnded` didn't let go of was taken away.
        .onChange(of: isDown) { _, isDown in
            if isDown { return pressed() }
            Task { letGo(swipedUp: nil) }
        }
        .accessibilityElement()
        .accessibilityLabel(isRecording ? "Pause dictating" : dictation.phase == .writing ? "Writing" : "Dictate")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { dictation.phase == .rest ? start() : dictation.tap() }
    }

    @ViewBuilder private var glyph: some View {
        switch dictation.phase {
        case .writing: Spinner(size: .small).foregroundStyle(Palette.fg)
        case .starting, .listening: Image(systemName: "pause.fill").font(.system(size: 16)).foregroundStyle(Palette.on)
        case .rest:
            Image(systemName: dictation.isRefused ? "mic.slash" : "mic").font(.system(size: 18))
                .foregroundStyle(dictation.isRefused ? Palette.muted : Palette.fg)
        }
    }

    private func pressed() {
        guard press == nil else { return }
        let at = Date.now
        press = (isRecording, at)
        if dictation.phase == .rest { start() }
        Task {
            try? await Task.sleep(for: .seconds(Self.holdAfter))
            if press?.at == at, isRecording { isHolding = true }
        }
    }

    /// His finger is up, or the press was taken away (`swipedUp` nil), which never sends.
    private func letGo(swipedUp: Bool?) {
        guard let press else { return }
        self.press = nil
        isHolding = false
        rise = nil
        if swipedUp == true && canSend { return dictation.swipeUp() }
        let wasHold = Date.now.timeIntervalSince(press.at) >= Self.holdAfter
        // A tap that started the run keeps it going, unless taken away, which drops it; a tap on a run, or the end of
        // a hold, pauses.
        if press.wasRecording || wasHold {
            dictation.pause()
        } else if swipedUp == nil {
            dictation.cancel()
        }
    }
}

/// Send, right of the microphone: dim with nothing to send, lit with words; while recording it dissolves (shrinks, blurs
/// and fades in 160 ms) and the microphone's hint takes its place.
private struct SendButton: View {
    let isHidden: Bool
    let isLit: Bool
    let send: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: send) {
            Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold))
                .foregroundStyle(isLit ? Palette.on : Palette.muted)
                .frame(width: 36, height: 36).background(isLit ? Palette.fg : Color.fillTint, in: .circle)
                .frame(minWidth: Metrics.tapTarget, minHeight: Metrics.tapTarget).contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!isLit || isHidden)
        .scaleEffect(isHidden && !reduceMotion ? 0.4 : 1)
        .blur(radius: isHidden && !reduceMotion ? 6 : 0)
        .opacity(isHidden ? 0 : 1)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: isHidden)
        .accessibilityLabel("Send")
        .accessibilityHidden(isHidden)
    }
}

/// While he records: two chevrons rising over the microphone, and the words.
private struct SwipeHint: View {
    var body: some View {
        HStack(spacing: Metrics.Spacing.xs) {
            Image(systemName: "chevron.up.2").font(.system(size: 13, weight: .semibold))
                .symbolEffect(.bounce.up, options: .repeating)
            Text("Swipe up to send").font(.small)
        }
        .foregroundStyle(Palette.on)
        .padding(.horizontal, Metrics.Spacing.m).frame(height: 32).background(Palette.fg, in: .capsule)
        .fixedSize()
        .accessibilityHidden(true)
    }
}

/// While he holds: a track rises from the microphone to a Send target. His thumb reaching it (`armed`) fills the target
/// with a tick: letting go then sends ("Let go to send").
private struct SendTrack: View {
    let rise: CGFloat

    static let reach: CGFloat = 120
    private var armed: Bool { rise >= Metrics.tapTarget }

    var body: some View {
        VStack(spacing: Metrics.Spacing.xs) {
            ZStack {
                Circle().fill(armed ? Palette.fg : Color.fillTint)
                Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(armed ? Palette.on : Palette.muted)
            }
            .frame(width: 44, height: 44)
            Capsule().fill(Color.fillTint).frame(width: 4, height: Self.reach - 44)
        }
        .offset(y: -44)
        .animation(.spring(duration: 0.22), value: armed)
        .sensoryFeedback(.impact(weight: .medium), trigger: armed) { _, new in new }
        .accessibilityHidden(true)
    }
}

/// While listening: cancel, the run's time and the stream; while writing: cancel, "Writing…" and the stream, still
/// and dim. An instant run's words (`live`, a one-line field's) take the stream's place; a stream that failed says the
/// Mac writes this run.
private struct ListeningLine: View {
    let dictation: Dictation
    let live: LiveWords?

    var body: some View {
        HStack(spacing: Metrics.Spacing.s) {
            Button(action: dictation.cancel) {
                Image(systemName: "xmark").font(.system(size: 14)).foregroundStyle(Palette.muted)
                    .frame(width: 28, height: 28).background(Color.fillTint, in: .circle)
                    .frame(minWidth: Metrics.tapTarget, minHeight: Metrics.tapTarget).contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel dictation")
            TimelineView(.periodic(from: dictation.runStarted, by: 1)) { context in
                Text(status(at: context.date)).font(.small).monospacedDigit().foregroundStyle(Palette.muted)
            }
            .fixedSize()
            if let live, !live.words.isEmpty, !live.hasFailed {
                LiveWordsText(words: live.words).lineLimit(1).truncationMode(.head)
            } else {
                DictationStream(dictation: dictation).opacity(dictation.phase == .writing ? 0.35 : 1)
            }
        }
    }

    private func status(at now: Date) -> String {
        let onTheMac = LiveWords.shared.hasFailed
        if dictation.phase == .writing { return onTheMac ? "Writing on your Mac…" : "Writing…" }
        return onTheMac ? "\(elapsed(at: now)) · On your Mac" : elapsed(at: now)
    }

    private func elapsed(at now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(dictation.runStarted)))
        return "\(seconds / 60):" + String(format: "%02d", seconds % 60)
    }
}

/// The run's sound: bars 2.5 wide and 2.5 apart, 3 high in silence (dots) to 22, born at the right and moving left one
/// bar per sample, continuously, faded over the last 48 points; flat dots at 35% where nothing was heard yet.
private struct DictationStream: View {
    let dictation: Dictation

    private static let pitch: CGFloat = 5
    private static let bar: CGFloat = 2.5
    private static let fade: CGFloat = 48

    var body: some View {
        TimelineView(.animation(paused: dictation.phase != .listening)) { context in
            Canvas { canvas, size in
                let levels = dictation.levels
                let step = Double(Dictation.sampleEvery.components.attoseconds) / 1e18
                let drift =
                    dictation.phase == .listening
                    ? min(context.date.timeIntervalSince(dictation.sampledAt) / step, 1) * Self.pitch : 0
                let count = Int(size.width / Self.pitch) + 1
                for slot in 0..<count {
                    let x = size.width - Self.bar - CGFloat(slot) * Self.pitch - drift
                    guard x > -Self.bar else { break }
                    let level = slot < levels.count ? levels[levels.count - 1 - slot] : nil
                    let height = 3 + 19 * CGFloat(level ?? 0)
                    let shade = (level == nil ? 0.35 : 1) * min(max(x / Self.fade, 0), 1)
                    let rect = CGRect(x: x, y: (size.height - height) / 2, width: Self.bar, height: height)
                    let bar = Path(roundedRect: rect, cornerRadius: Self.bar / 2)
                    canvas.fill(bar, with: .color(Palette.fg.opacity(shade)))
                }
            }
        }
        .frame(height: 22)
        .accessibilityHidden(true)
    }
}

/// Instant dictation's words between the field's own text (`head`, `tail`), each glyph fading in from the left as its
/// word lands (`LiveWords.opacity`); a word already shown never fades again, so a partial turning final doesn't flicker.
/// With Reduce Motion they appear at once.
struct LiveWordsText: View {
    var head = ""
    let words: [LiveWord]
    var tail = ""

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            text
        } else {
            // Frames only while a glyph is still fading; the last one draws every word whole.
            TimelineView(FramesUntil(end: LiveWords.settledAt(words))) { context in
                text.textRenderer(WordFade(words: words, now: context.date))
            }
        }
    }

    private var text: Text {
        let spoken = words.indices.reduce(Text(verbatim: head)) { line, i in
            let word = Text(verbatim: (i == 0 ? "" : " ") + words[i].text).customAttribute(SpokenWord(index: i))
            return Text("\(line)\(word)")
        }
        return Text("\(spoken)\(Text(verbatim: tail))")
    }
}

/// A frame every 1/60 s from now until `end`, then one at it.
private struct FramesUntil: TimelineSchedule {
    let end: Date

    func entries(from start: Date, mode: TimelineScheduleMode) -> AnyIterator<Date> {
        var next: Date? = min(start, end)
        return AnyIterator {
            guard let now = next else { return nil }
            next = now < end ? min(now.addingTimeInterval(1.0 / 60), end) : nil
            return now
        }
    }
}

/// Which live word a run of text is.
private struct SpokenWord: TextAttribute {
    let index: Int
}

/// Draws a live word glyph by glyph at its opacity now; the field's own text as it is.
private struct WordFade: TextRenderer {
    let words: [LiveWord]
    let now: Date

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        for run in layout.flatMap({ $0 }) {
            guard let index = run[SpokenWord.self]?.index, words.indices.contains(index) else {
                context.draw(run)
                continue
            }
            for (glyph, slice) in run.enumerated() {
                var faded = context
                faded.opacity = LiveWords.opacity(of: words[index], glyph: glyph, at: now)
                faded.draw(slice)
            }
        }
    }
}
