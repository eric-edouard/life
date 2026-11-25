import AVFAudio
import Accessibility
import ServerAPI
import SwiftUI

/// Every free-text field of the app: typing, and dictation as the spec of 22 Nov draws it
/// (`docs/product/app-design/dictation-2026-11-22.md` in his data repo): the field ends with its keys, the microphone and,
/// where the field has a single submit, Send (`DictationKeys`). A tap on the microphone starts a run and the next stops it;
/// a hold talks while held; a hold slid up sends (`DictationPress`). At each stop the run's words land where the caret
/// was. While listening, a one-line field's text line holds the cancel, the time and the stream; a tall field takes them
/// on a line under its text. Heard instantly (his `dictationHeard` switch), the words show as they come, fading in
/// (`LiveWordsText`). A field's font, colour, line limit, padding and box stay its caller's.
struct DictationField: View {
    let prompt: String
    /// What VoiceOver calls the field, when its prompt doesn't say it (a row's label).
    var label: String?
    @Binding var text: String
    var axis = Axis.horizontal
    var focused: FocusState<Bool>.Binding?
    /// Whether the field listens as it appears (Ask Life opened by its button: the press that opened it was the
    /// microphone's).
    var listens = false
    /// A field with a Send: the solid disc after the microphone, and a hold slid up from it. Every field with a single
    /// submit passes one (Ask Life, a matter's goal or next step, the new agent's goal) in place of its own Save or Start
    /// button; a card's answers stay buttons.
    var send: (() -> Void)?
    /// Ask Life's card (`ask-strip-2026-11-22.md`, "Live dictation on nav v3"): the words on top, up to 5 lines, then one
    /// row, cancel, the sound meter, stop and Send. Cancel hands what was said to `cancelled`, for its Undo.
    var isCard = false
    /// Whether a run is under way, for the edge's lights.
    var listening: Binding<Bool>?
    var cancelled: ((String) -> Void)?

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
    @State private var isHolding = false
    private let live = LiveWords.shared

    var body: some View {
        Group { if isCard { card } else { inline } }
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
            .onAppear {
                dictation.begin = DictationCapture.run(library: library, sync: sync)
                if listens { start() }
            }
            .onDisappear { dictation.cancel() }
            .onChange(of: dictation.phase) { _, phase in listening?.wrappedValue = phase != .rest }
            .onChange(of: dictation.landed) { _, landed in
                if let landed { land(landed) }
            }
    }

    private var inline: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            if let problem = dictation.problem { ProblemLine(problem: problem) { fix(problem) }.appears() }
            HStack(alignment: axis == .vertical ? .bottom : .center, spacing: Metrics.Spacing.s) {
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                    // An empty tall field dictates on its one line, as a one-line field does.
                    let isLineInPlace = dictation.phase != .rest && (axis == .horizontal || text.isEmpty)
                    let isTallLive = !isLineInPlace && isLive
                    // Both stay in the stack: the field keeps its height, the live text grows it as words come.
                    ZStack(alignment: .topLeading) {
                        field.opacity(isLineInPlace || isTallLive ? 0 : 1)
                        if isTallLive {
                            let (head, tail) = DictatedText.parts(in: text, at: keptCaret)
                            // The caller's line limit holds; past it, the newest words stay in sight.
                            LiveWordsText(head: head, words: live.words, tail: tail).truncationMode(.head)
                        }
                    }
                    .overlay(alignment: .leading) {
                        if isLineInPlace { ListeningLine(dictation: dictation, live: isLive ? live : nil).appears() }
                    }
                    if !isLineInPlace, dictation.phase != .rest {
                        ListeningLine(dictation: dictation, live: nil).appears()
                    }
                }
                // One line sits centred on the keys; more grow up from them.
                .frame(minHeight: Metrics.tapTarget)
                DictationKeys(dictation: dictation, hasWords: hasWords, send: send, start: start)
            }
        }
    }

    /// Ask Life's card: grows upward with the words (its foot row never moves); the meter shows with the live words.
    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let problem = dictation.problem { ProblemLine(problem: problem) { fix(problem) }.appears() }
            cardWords.frame(maxWidth: .infinity, alignment: .leading).padding(.top, Metrics.Spacing.m)
            HStack(spacing: Metrics.Spacing.s) {
                Button(action: cancel) {
                    Image(systemName: "xmark").font(.system(size: 14)).foregroundStyle(Palette.muted)
                        .frame(width: 36, height: 36).background(Palette.tint, in: .circle)
                        .frame(minWidth: Metrics.tapTarget, minHeight: Metrics.tapTarget).contentShape(.rect)
                }
                .buttonStyle(.plain).accessibilityLabel("Cancel dictation")
                Group {
                    if dictation.phase == .rest {
                        Color.clear
                    } else if isHolding {
                        Text("Slide up to send").font(.line).foregroundStyle(Palette.muted)
                    } else {
                        DictationStream(dictation: dictation)
                    }
                }
                .frame(maxWidth: .infinity)
                DictationKeys(
                    dictation: dictation, hasWords: hasWords, send: send, start: start, isCard: true,
                    isHolding: $isHolding)
            }
            .frame(height: 56)
        }
    }

    @ViewBuilder private var cardWords: some View {
        if dictation.phase == .rest {
            field.lineLimit(1...5)
        } else if isLive {
            let (head, tail) = DictatedText.parts(in: text, at: keptCaret)
            LiveWordsText(head: head, words: live.words, tail: tail).lineLimit(5).truncationMode(.head)
        } else if text.isEmpty {
            Text(dictation.phase == .writing ? "Writing…" : "Listening…").foregroundStyle(Palette.muted)
        } else {
            Text(text).lineLimit(5).truncationMode(.head)
        }
    }

    /// Stops the run, drops its words and hands what was said back (his text and the words heard), for Undo.
    private func cancel() {
        let said = DictatedText.said(typed: text, heard: isLive ? live.words.map(\.text) : [])
        dictation.cancel()
        live.clear()
        cancelled?(said)
    }

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

    /// The words at the caret he left, then, for a run stopped by Send, the Send, which reads the text with them.
    private func land(_ landed: Dictation.Landed) {
        live.clear()
        // A run that heard nothing still sends what the field holds, when it was stopped by Send.
        if let landing = DictatedText.inserting(landed.words, into: text, at: keptCaret) {
            text = landing.text
            selection = TextSelection(insertionPoint: landing.caret)
            AccessibilityNotification.Announcement(landed.words).post()
        }
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
            Text(problem.line).font(.line).foregroundStyle(Palette.flag)
            if let link = problem.fix { QuietChip(link.title, symbol: link.symbol, action: fix) }
        }
    }
}

/// The field's keys, two 36 discs (44 to hit) in one glass container, so they sample each other and melt as the
/// microphone leaves and comes home: the microphone, clear glass, and Send, a solid `fg` disc (the Claude app's Stop,
/// his reference of 22 Nov), only where the field has a Send. Send is lit with words or a run to send.
private struct DictationKeys: View {
    let dictation: Dictation
    let hasWords: Bool
    let send: (() -> Void)?
    let start: () -> Void
    var isCard = false
    /// The press's hold, for the card's "Slide up to send" in the meter's place.
    var isHolding: Binding<Bool>?

    @State private var press: DictationPress

    init(
        dictation: Dictation, hasWords: Bool, send: (() -> Void)?, start: @escaping () -> Void, isCard: Bool = false,
        isHolding: Binding<Bool>? = nil
    ) {
        (self.dictation, self.hasWords, self.send, self.start) = (dictation, hasWords, send, start)
        (self.isCard, self.isHolding) = (isCard, isHolding)
        _press = State(initialValue: DictationPress(canSend: send != nil))
    }

    var body: some View {
        GlassEffectContainer(spacing: Metrics.Spacing.s) {
            HStack(spacing: Metrics.Spacing.s) {
                DictationMic(dictation: dictation, press: $press, start: start, isCard: isCard)
                if let send {
                    // Off while a run's words are written: they land first.
                    SendKey(
                        dictation: dictation,
                        isLit: (isRunning || hasWords && dictation.phase == .rest) && !press.isArmed, send: send)
                }
            }
        }
        .onChange(of: press.isHolding) { _, holding in isHolding?.wrappedValue = holding }
    }

    private var isRunning: Bool { dictation.phase == .starting || dictation.phase == .listening }
}

/// Send: a solid `fg` disc, the arrow in `on`; dim with nothing to send, the spinner while a run it stopped is written.
/// Tapped while a run is under way, it stops the run and sends once the words land.
private struct SendKey: View {
    let dictation: Dictation
    let isLit: Bool
    let send: () -> Void

    var body: some View {
        Button {
            if dictation.phase == .rest { send() } else { dictation.send() }
        } label: {
            Group {
                if dictation.isSending {
                    Spinner(size: .small).foregroundStyle(Palette.on)
                } else {
                    Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(isOn ? Palette.on : Palette.muted)
                }
            }
            .frame(width: 36, height: 36)
            // Dim is the glass's own tint: the container draws the glass, so an opacity on the view would miss it.
            .glassEffect(.regular.tint(Palette.fg.opacity(isOn ? 1 : 0.35)).interactive(), in: .circle)
            .frame(minWidth: Metrics.tapTarget, minHeight: Metrics.tapTarget).contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!isLit || dictation.isSending)
        .accessibilityLabel("Send")
    }

    private var isOn: Bool { isLit || dictation.isSending }
}

/// The microphone: a 36 disc of clear glass (`.interactive()`, the system's press). At rest the microphone (slashed and
/// muted when refused); listening, tinted `ai` with Life's voice mark following his level; held, 1.12 big with a chevron
/// over it where a slide sends; slid up, it follows the thumb (`DictationPress.lift`) and, armed, turns into Send; let go
/// armed, it flies on up and fades, decisive. Writing, the spinner (muted while Send holds the spinner).
private struct DictationMic: View {
    let dictation: Dictation
    @Binding var press: DictationPress
    /// Starts a run from rest (the field keeps its caret first).
    let start: () -> Void
    /// Ask Life's card: a stop square while listening, in the place of the voice mark.
    var isCard = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Whether his finger is down; false again once it is up, or once the system took the gesture away.
    @GestureState private var isDown = false
    /// How high a slide that sent was let go, while the microphone flies on from there; nil once it is home.
    @State private var flight: Double?
    @State private var isGone = false

    private var isRunning: Bool { dictation.phase == .starting || dictation.phase == .listening }

    var body: some View {
        glyph
            .frame(width: 36, height: 36)
            .glassEffect(glass, in: .circle)
            .overlay(alignment: .top) {
                if press.isHolding, press.canSend, !press.isArmed {
                    Image(systemName: "chevron.up").font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Palette.muted).offset(y: -18).transition(.opacity)
                }
            }
            .scaleEffect(isGone ? 0.6 : press.isHolding ? 1.12 : 1)
            .offset(y: reduceMotion ? 0 : -(flight.map { $0 + (isGone ? 24 : 0) } ?? press.lift))
            .opacity(isGone ? 0 : 1)
            // With the thumb while it is down, home with a little spring once it lets go.
            .animation(
                press.isDown ? Motion.thumbFollows : Motion.thumbHome,
                value: press.lift
            )
            .animation(Motion.thumbGrows, value: press.isHolding)
            .motion(Motion.armed, value: press.isArmed)
            .frame(minWidth: Metrics.tapTarget, minHeight: Metrics.tapTarget)
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 0).updating($isDown) { _, isDown, _ in isDown = true }
                    .onChanged { value in
                        if press.isDown { press.move(up: -value.translation.height) } else { pressed() }
                    }
                    .onEnded { _ in act(press.release(at: Self.now)) }
            )
            // A gesture the system takes away (a scroll, an alert) never ends; its state resets all the same, after
            // which a press `onEnded` didn't let go of was taken away.
            .onChange(of: isDown) { _, isDown in
                if !isDown { Task { act(press.takenAway()) } }
            }
            .sensoryFeedback(trigger: press.isArmed) { _, armed in
                armed ? .impact(flexibility: .rigid) : .impact(flexibility: .soft, intensity: 0.5)
            }
            .accessibilityElement()
            .accessibilityLabel(isRunning ? "Stop dictating" : dictation.phase == .writing ? "Writing" : "Dictate")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { dictation.phase == .rest ? start() : dictation.tap() }
            .accessibilityAction(named: "Send") { if press.canSend, isRunning { dictation.send() } }
    }

    private var glass: Glass {
        if press.isArmed || flight != nil { return .regular.tint(Palette.fg).interactive() }
        return isRunning ? .regular.tint(Palette.ai).interactive() : .regular.interactive()
    }

    @ViewBuilder private var glyph: some View {
        if press.isArmed || flight != nil {
            Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.on)
        } else {
            switch dictation.phase {
            case .writing where !dictation.isSending: Spinner(size: .small).foregroundStyle(Palette.fg)
            case .starting, .listening:
                if isCard {
                    Image(systemName: "stop.fill").font(.system(size: 14)).foregroundStyle(Palette.on)
                } else {
                    VoiceMark(level: dictation.levels.last ?? 0)
                }
            case .rest, .writing:
                Image(systemName: dictation.isRefused ? "mic.slash" : "mic").font(.system(size: 17))
                    .foregroundStyle(dictation.isRefused || dictation.isSending ? Palette.muted : Palette.fg)
            }
        }
    }

    private static var now: Double { ProcessInfo.processInfo.systemUptime }

    private func pressed() {
        let at = Self.now
        act(press.press(at: at, isRunning: dictation.phase != .rest))
        Task {
            try? await Task.sleep(for: .seconds(DictationPress.holdAfter))
            if isRunning { press.held(since: at) }
        }
    }

    private func act(_ act: DictationPress.Act?) {
        switch act {
        case .start: start()
        case .stop: dictation.pause()
        case .cancel: dictation.cancel()
        case .send: fly()
        case nil: break
        }
    }

    /// The slide that sends: the run stops with `sends`, and the microphone flies on from where it was let go, then is
    /// home again, still.
    private func fly() {
        let from = press.lift
        dictation.send()
        guard !reduceMotion else { return }
        flight = from
        withAnimation(Motion.flightOff) {
            isGone = true
        } completion: {
            var still = Transaction()
            still.disablesAnimations = true
            withTransaction(still) { (flight, isGone) = (nil, false) }
        }
    }
}

/// Life's voice mark while he speaks: five rounded bars, the middle tallest (the Ask Life button's mark), their height
/// following his level, in `on` on the `ai` glass.
private struct VoiceMark: View {
    let level: Double

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let heights: [CGFloat] = [8, 14, 20, 14, 8]

    var body: some View {
        HStack(spacing: 1.8) {
            ForEach(0..<5, id: \.self) { i in
                Capsule().frame(width: 2.6, height: Self.heights[i] * (0.4 + 0.6 * level))
            }
        }
        .foregroundStyle(Palette.on)
        .frame(height: 20)
        .motion(Motion.level, value: level)
        .accessibilityHidden(true)
    }
}

/// While listening: cancel, the run's time and the stream; while writing: cancel, "Writing…" ("Sending…" for a run
/// that sends) and the stream, still and dim. An instant run's words (`live`, a one-line field's) take the stream's place; a stream that failed says the
/// Mac writes this run.
private struct ListeningLine: View {
    let dictation: Dictation
    let live: LiveWords?

    var body: some View {
        HStack(spacing: Metrics.Spacing.s) {
            Button(action: dictation.cancel) {
                Image(systemName: "xmark").font(.system(size: 14)).foregroundStyle(Palette.muted)
                    .frame(width: 28, height: 28).background(Palette.tint, in: .circle)
                    .frame(minWidth: Metrics.tapTarget, minHeight: Metrics.tapTarget).contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel dictation")
            TimelineView(.periodic(from: dictation.runStarted, by: 1)) { context in
                Text(status(at: context.date)).font(.line).monospacedDigit().foregroundStyle(Palette.muted)
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
        if dictation.phase == .writing {
            if dictation.isSending { return "Sending…" }
            return onTheMac ? "Writing on your Mac…" : "Writing…"
        }
        return onTheMac ? "\(elapsed(at: now)) · On your Mac" : elapsed(at: now)
    }

    private func elapsed(at now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(dictation.runStarted)))
        return "\(seconds / 60):" + String(format: "%02d", seconds % 60)
    }
}

/// The run's sound: bars 2.5 wide and 2.5 apart, 3 high in silence (dots) to 22, born at the right and moving left one
/// bar per sample, continuously (a step per sample under Reduce Motion), faded over the last 48 points; flat dots at 35%
/// where nothing was heard yet.
private struct DictationStream: View {
    let dictation: Dictation

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let pitch: CGFloat = 5
    private static let bar: CGFloat = 2.5
    private static let fade: CGFloat = 48

    var body: some View {
        TimelineView(.animation(paused: dictation.phase != .listening)) { context in
            Canvas { canvas, size in
                let levels = dictation.levels
                let step = Double(Dictation.sampleEvery.components.attoseconds) / 1e18
                let drift =
                    dictation.phase == .listening && !reduceMotion
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
