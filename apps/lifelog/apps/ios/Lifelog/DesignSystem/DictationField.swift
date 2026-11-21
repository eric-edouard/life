import AVFAudio
import Accessibility
import ServerAPI
import SwiftUI

/// Every free-text field of the app: typing, and the one microphone (decision 87; the dictation spec of 20 Nov). A tap
/// on the microphone starts a run, a tap pauses it and a tap goes on; a hold records while held. At each pause the
/// run's words land where the caret was (the Mac's recognition doesn't stream). While listening, a one-line field's
/// text line holds the cancel, the time and the stream; a tall field takes them on a line under its text. A field's
/// font, colour, line limit, padding and fill stay its caller's.
struct DictationField: View {
    let prompt: String
    /// What VoiceOver calls the field, when its prompt doesn't say it (a row's label).
    var label: String?
    @Binding var text: String
    var axis = Axis.horizontal
    var focused: FocusState<Bool>.Binding?
    /// A field with a Send (Tell Life, later): a swipe up from the microphone sends once the words landed. No 4b field
    /// passes one, and its Send and track aren't drawn yet.
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

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            if let problem = dictation.problem { ProblemLine(problem: problem) { fix(problem) }.appears() }
            HStack(alignment: axis == .vertical ? .bottom : .center, spacing: Metrics.Spacing.s) {
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                    let isOneLineBusy = axis == .horizontal && dictation.phase != .rest
                    field.opacity(isOneLineBusy ? 0 : 1)
                        .overlay(alignment: .leading) { if isOneLineBusy { ListeningLine(dictation: dictation) } }
                    if axis == .vertical, dictation.phase != .rest { ListeningLine(dictation: dictation).appears() }
                }
                DictationMic(dictation: dictation, canSend: send != nil, start: start)
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

    /// The words at the caret he left, or at the end when the text changed since; then, on a swipe up, the Send.
    private func land(_ landed: Dictation.Landed) {
        var range: Range<String.Index>?
        if let caret, caret.text == text, case .selection(let picked)? = caret.selection?.indices { range = picked }
        let (new, at) = DictatedText.inserting(landed.words, into: text, at: range)
        guard new != text else { return }
        text = new
        selection = TextSelection(insertionPoint: at)
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
    /// Starts a run from rest (the field keeps its caret first).
    let start: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// His finger's travel while it is down; nil once it is up, or the system took the gesture away.
    @GestureState private var drag: CGSize?
    @State private var travel = CGSize.zero
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
        .gesture(DragGesture(minimumDistance: 0).updating($drag) { value, drag, _ in drag = value.translation })
        // Ended or cancelled alike, the finger is up: a hold never outlives it.
        .onChange(of: drag) { old, new in
            if let new { travel = new }
            if old == nil, new != nil { pressed() }
            if old != nil, new == nil { letGo(swipedUp: travel.height < -Metrics.tapTarget) }
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

    private func letGo(swipedUp: Bool) {
        guard let press else { return }
        self.press = nil
        isHolding = false
        if swipedUp && canSend { return dictation.swipeUp() }
        let wasHold = Date.now.timeIntervalSince(press.at) >= Self.holdAfter
        // A tap that started the run keeps it going; a tap on a run, or the end of a hold, pauses.
        if press.wasRecording || wasHold { dictation.pause() }
    }
}

/// While listening: cancel, the run's time and the stream; while writing: cancel, "Writing…" and the stream, still
/// and dim.
private struct ListeningLine: View {
    let dictation: Dictation

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
                Text(dictation.phase == .writing ? "Writing…" : elapsed(at: context.date))
                    .font(.small).monospacedDigit().foregroundStyle(Palette.muted)
            }
            .fixedSize()
            DictationStream(dictation: dictation).opacity(dictation.phase == .writing ? 0.35 : 1)
        }
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
