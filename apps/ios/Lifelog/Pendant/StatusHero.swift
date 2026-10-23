import SwiftUI

/// The controls under the lens: a button that names what tapping does, and the scissors. The header above them (the
/// lens and its word) gets the reading with this screen's reconnect attempt laid over it, and is hidden from VoiceOver:
/// the button speaks the sentence and its evidence, "Recording. Confirmed by the Pendant 6 seconds ago", "Double-tap to
/// pause."
struct StatusHero<Header: View>: View {
    let reading: HeroReading
    let perform: (HeroReading.Control) -> Void
    let recover: (Recovery) -> Void
    /// Ends the conversation at this moment. Only offered while the Pendant confirms it is recording.
    let split: () -> Void
    @ViewBuilder let header: (HeroReading) -> Header

    /// A reconnect asked for here, waiting to see whether the Pendant comes back. Only ever local feedback.
    @State private var reach: Reach?

    private enum Reach {
        case trying
        case failed
    }

    /// The reading with this screen's own reconnect attempt laid over it.
    private var shown: HeroReading {
        var shown = reading
        switch reach {
        case .trying?:
            shown.sentence = "Trying to reach it…"
            shown.voice = .waiting
            shown.mode = .waiting
        case .failed?:
            shown.failure = "Couldn't reach the Pendant · nothing changed"
        case nil: break
        }
        return shown
    }

    var body: some View {
        let shown = shown
        VStack(spacing: 22) {
            header(shown)
                .accessibilityHidden(true)
            if let recovery = shown.recovery {
                Button(recovery.title) { recover(recovery) }
                    .primaryGlassButton()
                    .accessibilityIdentifier("pendant.hero.recovery")
                    .controlSize(.large)
                    .transition(.blurReplace)
            }
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    let isEnabled = shown.control != .none && reach != .trying
                    RecordingButton(
                        control: reach == .trying ? .none : shown.control, title: title(shown),
                        isBusy: shown.isBusy || reach == .trying, isEnabled: isEnabled, action: tap
                    )
                    .accessibilityLabel(spoken(shown))
                    .accessibilityHint(hint(shown.control))
                    // The hero's one element: its label is the sentence and evidence, so UI flows read the hero here.
                    .accessibilityIdentifier("pendant.switch")
                    .accessibilitySortPriority(1)
                    SplitButton(isEnabled: shown.mode == .live, action: split)
                }
                // The scissors take the button's height, even when a large title makes it taller.
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
        .motion(Motion.rise, value: shown)
        .onChange(of: reading.mode) { _, mode in
            if mode != .notConnected { reach = nil }
        }
        .onChange(of: reading.sentence) { _, sentence in
            AccessibilityNotification.Announcement(sentence).post()
        }
        .task(id: reach) {
            // Give a reconnect a few seconds; if the Pendant isn't back, say so, then let it go.
            // A newer attempt or the Pendant coming back cancels this one; it then changes nothing.
            switch reach {
            case .trying?:
                guard (try? await Task.sleep(for: .seconds(4))) != nil else { return }
                reach = .failed
            case .failed?:
                guard (try? await Task.sleep(for: .seconds(5))) != nil else { return }
                reach = nil
            case nil: break
            }
        }
    }

    private func tap() {
        if reading.control == .reconnect { reach = .trying }
        perform(reading.control)
    }

    /// The action in a word, for a control that leaves the state to the header.
    private func title(_ reading: HeroReading) -> String {
        if reach == .trying { return "Trying…" }
        return switch reading.control {
        case .pause: "Pause"
        case .resume: reading.mode == .waiting ? "Record" : "Resume"
        case .reconnect: "Try again"
        case .none: reading.isBusy ? "Waiting for Pendant…" : "Pendant not connected"
        }
    }

    private func spoken(_ reading: HeroReading) -> Text {
        var text = Text(reading.sentence)
        if let sound = reading.sound { text = Text("\(text) \(Self.ended(sound.text))") }
        for line in reading.evidence {
            switch line {
            case .confirmed(let lead, let at):
                text = Text("\(text) \(lead) \(Text(.currentDate, format: .ago(at))).")
            case .line(let line):
                text = Text("\(text) \(Self.ended(line))")
            }
        }
        if let failure = reading.failure { text = Text("\(text) \(Self.ended(failure))") }
        return text
    }

    /// A line as a spoken sentence: a full stop only where it doesn't end in one already.
    private static func ended(_ line: String) -> String {
        line.last.map { ".!?…".contains($0) } == true ? line : line + "."
    }

    private func hint(_ control: HeroReading.Control) -> String {
        switch control {
        case .pause: "Double-tap to pause."
        case .resume: "Double-tap to resume."
        case .reconnect: "Double-tap to try reaching the Pendant."
        case .none: ""
        }
    }
}

/// One line of evidence; a confirmation's "6 seconds ago" keeps counting on its own.
struct EvidenceText: View {
    let line: HeroReading.Evidence

    var body: some View {
        Group {
            switch line {
            case .confirmed(let lead, let at):
                Text("\(lead) \(Text(.currentDate, format: .ago(at)))")
            case .line(let text):
                Text(text)
            }
        }
        .monospacedDigit()
        .contentTransition(.numericText())
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// A spinning arc for "waiting on the Pendant". Under Reduce Motion the arc holds still.
struct PendingRing: View {
    var lineWidth: CGFloat = 2
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Circle().stroke(Palette.textPrimary.opacity(0.12), lineWidth: lineWidth)
            TimelineView(.animation(paused: reduceMotion)) { context in
                Circle()
                    .trim(from: 0, to: 0.26)
                    .stroke(Palette.textPrimary, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(
                        .degrees(context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1) * 360))
            }
        }
        .accessibilityHidden(true)
    }
}

/// Scissors beside the record button: ends the conversation now, as "Split here" does in a transcript. Never touches the
/// Pendant, so recording goes on.
struct SplitButton: View {
    let isEnabled: Bool
    let action: () -> Void

    @State private var taps = 0

    var body: some View {
        Button {
            taps += 1
            action()
        } label: {
            Image(systemName: "scissors")
                .font(.title2)
                .foregroundStyle(isEnabled ? Palette.textPrimary : Palette.textTertiary)
                .frame(width: 72)
                .frame(maxHeight: .infinity)
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .glassEffect(.regular.interactive(), in: .capsule)
        .sensoryFeedback(.impact(weight: .light), trigger: taps)
        .accessibilityLabel("Split the conversation here")
        .accessibilityIdentifier("pendant.split")
    }
}

/// The record control as a plain action: what tapping does, in a word and a glyph, beside a header that already
/// shows the state. Red only for the action that starts recording; no glass at all without a link.
struct RecordingButton: View {
    let control: HeroReading.Control
    let title: String
    let isBusy: Bool
    let isEnabled: Bool
    let action: () -> Void

    @State private var taps = 0

    var body: some View {
        let records = control == .resume && isEnabled
        let unlinked = control == .none && !isBusy
        Button {
            taps += 1
            action()
        } label: {
            Label {
                Text(title)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                    .contentTransition(.opacity)
            } icon: {
                icon.accessibilityHidden(true)
            }
            .font(.headline)
            .foregroundStyle(
                records ? Palette.textOnRed : isBusy || !isEnabled ? Palette.textSecondary : Palette.textPrimary
            )
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity, minHeight: 56)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .background {
            if unlinked {
                Capsule().strokeBorder(Palette.textTertiary, style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
            }
        }
        .glassEffect(
            records ? .regular.tint(Palette.redFill).interactive() : unlinked ? .identity : .regular.interactive(),
            in: .capsule
        )
        .motion(Motion.standard, value: control)
        .motion(Motion.standard, value: isBusy)
        .sensoryFeedback(.impact(weight: .light), trigger: taps)
        .accessibilityRemoveTraits(isEnabled ? [] : .isButton)
    }

    @ViewBuilder private var icon: some View {
        if isBusy {
            PendingRing(lineWidth: 2).frame(width: 18, height: 18)
        } else {
            switch control {
            case .pause: Image(systemName: "pause.fill")
            case .resume: Image(systemName: "circle.fill")
            case .reconnect: Image(systemName: "arrow.clockwise")
            case .none: Image(systemName: "antenna.radiowaves.left.and.right.slash")
            }
        }
    }
}
