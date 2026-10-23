import Capture
import OwnerSettings
import SwiftUI

/// What the Pendant's light means, each light in its real color blinking its real pattern (docs/voice/pendant.md). It is
/// the official guide, not what the light shows now. Under Reduce Motion every light holds still.
struct LightGuide: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        OnScreenTimeline(minimumInterval: LightPattern.frame, paused: reduceMotion) { date in
            let time = reduceMotion ? nil : date.timeIntervalSinceReferenceDate
            VStack(alignment: .leading, spacing: 0) {
                ForEach(LightPattern.allCases.filter { !$0.isProblem }) { LightRow(pattern: $0, time: time) }
                Text("When something's wrong")
                    .font(.footnote)
                    .foregroundStyle(Palette.textTertiary)
                    .padding(.top, 14)
                    .padding(.bottom, 4)
                    .accessibilityAddTraits(.isHeader)
                ForEach(LightPattern.allCases.filter(\.isProblem)) { LightRow(pattern: $0, time: time) }
            }
        }
    }
}

/// One light in the guide, in the Pendant's own words.
enum LightPattern: CaseIterable, Identifiable {
    case recording
    case recordingWhileCharging
    case recordingFullyCharged
    case readyToPair
    case clockNeedsSync
    case storageFull
    case temperature
    case microphoneFailed
    case startUpError
    case factoryReset

    var id: Self { self }

    /// Fast enough for the quickest blink (60 ms on, startUpError), no faster.
    static let frame = 1.0 / 30

    var label: String {
        switch self {
        case .recording: "Recording"
        case .recordingWhileCharging: "Recording while charging"
        case .recordingFullyCharged: "Recording, fully charged"
        case .readyToPair: "Ready to pair"
        case .clockNeedsSync: "Clock needs a sync"
        case .storageFull: "Storage full"
        case .temperature: "Too hot or cold"
        case .microphoneFailed: "Microphone failed"
        case .startUpError: "Start-up error"
        case .factoryReset: "Factory reset"
        }
    }

    var pattern: String {
        switch self {
        case .recording: "Steady white"
        case .recordingWhileCharging: "White, then orange"
        case .recordingFullyCharged: "White, then green"
        case .readyToPair: "Steady blue"
        case .clockNeedsSync: "Red ×3, repeating · reconnect"
        case .storageFull: "Red ×10, repeating · sync fully"
        case .temperature: "Red ×4 every 5 s"
        case .microphoneFailed: "Breathing red · restart it"
        case .startUpError: "Very fast red · recovery mode"
        case .factoryReset: "Purple · erases unsynced audio"
        }
    }

    var isProblem: Bool {
        switch self {
        case .recording, .recordingWhileCharging, .recordingFullyCharged, .readyToPair: false
        default: true
        }
    }

    /// The light's own colors: real LED colors, not the app's palette.
    var colors: (Color, Color?) {
        let white = Color.white
        let red = Color(red: 1, green: 0.27, blue: 0.23)
        return switch self {
        case .recording: (white, nil)
        case .recordingWhileCharging: (white, Color(red: 1, green: 0.62, blue: 0.04))
        case .recordingFullyCharged: (white, Color(red: 0.19, green: 0.82, blue: 0.35))
        case .readyToPair: (Color(red: 0.04, green: 0.52, blue: 1), nil)
        case .factoryReset: (Color(red: 0.75, green: 0.35, blue: 0.95), nil)
        default: (red, nil)
        }
    }

    /// How lit each color is at `time` (seconds), 0...1. `nil` time is a still frame: the first color on.
    func intensity(at time: TimeInterval?) -> (first: Double, second: Double) {
        guard let time else { return (1, 0) }
        func blinks(_ count: Int, on: Double, every period: Double, cycle: Double) -> Double {
            let phase = time.truncatingRemainder(dividingBy: cycle)
            let blink = Int(phase / period)
            return blink < count && phase - Double(blink) * period < on ? 1 : 0
        }
        switch self {
        case .recording, .readyToPair, .factoryReset: return (1, 0)
        case .recordingWhileCharging, .recordingFullyCharged:
            let first = time.truncatingRemainder(dividingBy: 2.4) < 1.2
            return (first ? 1 : 0, first ? 0 : 1)
        case .clockNeedsSync: return (blinks(3, on: 0.25, every: 0.5, cycle: 3.2), 0)
        case .storageFull: return (blinks(10, on: 0.15, every: 0.3, cycle: 4.6), 0)
        case .temperature: return (blinks(4, on: 0.18, every: 0.36, cycle: 5), 0)
        case .microphoneFailed: return (0.08 + 0.92 * (0.5 - 0.5 * cos(time * 2 * .pi / 3)), 0)
        case .startUpError: return (blinks(1, on: 0.06, every: 0.12, cycle: 0.12), 0)
        }
    }
}

private struct LightRow: View {
    let pattern: LightPattern
    let time: TimeInterval?

    var body: some View {
        let (first, second) = pattern.colors
        let lit = pattern.intensity(at: time)
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(Palette.textPrimary.opacity(0.08))
                LightDot(color: first, intensity: lit.first)
                if let second { LightDot(color: second, intensity: lit.second) }
            }
            .frame(width: 10, height: 10)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(pattern.label).font(.subheadline).foregroundStyle(Palette.textBody)
                Text(pattern.pattern).font(.footnote).foregroundStyle(Palette.textTertiary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 9)
        .overlay(alignment: .top) { Hairline() }
        .accessibilityElement(children: .combine)
    }
}

/// Every light in a row, as on a hardware panel, each blinking its real pattern; tap one to read what it means. Under
/// Reduce Motion every light holds still.
struct LightStrip: View {
    @State private var selected = LightPattern.recording
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            OnScreenTimeline(minimumInterval: LightPattern.frame, paused: reduceMotion) { date in
                let time = reduceMotion ? nil : date.timeIntervalSinceReferenceDate
                HStack(spacing: 0) {
                    ForEach(LightPattern.allCases) { pattern in
                        Button {
                            selected = pattern
                        } label: {
                            LightWell(pattern: pattern, time: time, isSelected: pattern == selected)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(pattern.label)
                        .accessibilityValue(pattern.pattern)
                        .accessibilityAddTraits(pattern == selected ? .isSelected : [])
                    }
                }
            }
            .sensoryFeedback(.selection, trigger: selected)
            VStack(alignment: .leading, spacing: 2) {
                Text(selected.label).font(.subheadline).foregroundStyle(Palette.textBody)
                Text(selected.pattern).font(.footnote).foregroundStyle(Palette.textTertiary)
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityHidden(true)
        }
    }
}

/// One light of the strip, sunk into the faceplate; ringed while it is the one being read.
private struct LightWell: View {
    let pattern: LightPattern
    let time: TimeInterval?
    let isSelected: Bool

    var body: some View {
        let (first, second) = pattern.colors
        let lit = pattern.intensity(at: time)
        ZStack {
            Circle().fill(Palette.ground)
            Circle().strokeBorder(
                isSelected ? Palette.textSecondary : Palette.hairline, lineWidth: isSelected ? 1.5 : 0.5)
            ZStack {
                Circle().fill(Palette.textPrimary.opacity(0.08))
                LightDot(color: first, intensity: lit.first)
                if let second { LightDot(color: second, intensity: lit.second) }
            }
            .frame(width: 10, height: 10)
        }
        .frame(width: 30, height: 30)
    }
}

private struct LightDot: View {
    let color: Color
    let intensity: Double

    var body: some View {
        Circle()
            .fill(color)
            .shadow(color: color.opacity(0.8), radius: 3)
            .shadow(color: color.opacity(0.4), radius: 7)
            .opacity(intensity)
    }
}

/// The recording light's brightness, a Settings row. It changes only while the Pendant is connected, since only then
/// can it be sent. Nothing is selected until the owner picks: the light's level is never read back.
struct LightBrightnessRow: View {
    let isConnected: Bool
    let set: (LightBrightness) async -> Bool

    @Bindable private var settings = Settings.shared
    @State private var asksIfChanged = false
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text("Brightness")
                Spacer(minLength: 8)
                Picker("Brightness", selection: selection) {
                    if settings.lightBrightnessLevel == nil { Text("Not set").tag(LightBrightness?.none) }
                    ForEach(LightBrightness.allCases) { step in
                        Text(step.name).tag(Optional(step))
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .disabled(!isConnected)
                .accessibilityIdentifier("pendant.settings.lightBrightness")
            }
            Text(caption)
                .font(.footnote)
                .foregroundStyle(Palette.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 12)
        .alert("Did the light change?", isPresented: $asksIfChanged) {
            Button("Yes") { settings.lightBrightnessCheck = .changed }
            Button("No") { settings.lightBrightnessCheck = .unchanged }
        } message: {
            Text("Look at the Pendant. Your answer tells Life whether its firmware takes this setting.")
        }
    }

    /// A get/set pair on purpose: a pick shows as chosen only once the Pendant took it.
    private var selection: Binding<LightBrightness?> {
        Binding {
            settings.lightBrightnessLevel.flatMap(LightBrightness.init(rawValue:))
        } set: { step in
            guard let step else { return }
            Task {
                // Shown as chosen only once it reached the Pendant.
                failed = !(await set(step))
                guard !failed else { return }
                settings.lightBrightnessLevel = step.rawValue
                if settings.lightBrightnessCheck == .unasked { asksIfChanged = true }
            }
        }
    }

    private var caption: String {
        if failed { return "That didn't reach the Pendant. Try again in a moment." }
        if !isConnected { return "Connect the Pendant to change it." }
        let off = "Off may turn the light off, and then people nearby can't tell it's recording."
        return switch settings.lightBrightnessCheck {
        case .unasked: "Not confirmed on your Pendant yet: the first change asks whether the light changed. \(off)"
        case .changed: "You saw it work on your Pendant. \(off)"
        case .unchanged: "You saw no change last time, so your Pendant's firmware may ignore this."
        }
    }
}

extension LightBrightness {
    var name: String {
        switch self {
        case .off: "Off"
        case .dimmest: "Dimmest"
        case .low: "Low"
        case .medium: "Medium"
        case .bright: "Bright"
        }
    }
}

/// What the Pendant's light means, pushed from Settings: the strip to tap through, then every light in words.
struct LightGuideView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Tap a light to read it. They blink as the Pendant does.")
                        .font(.footnote)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    LightStrip()
                }
                .padding(Metrics.cardPadding)
                .card()
                LightGuide()
                    .padding(.horizontal, Metrics.cardPadding)
                    .padding(.bottom, 6)
                    .card()
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .background(Palette.ground)
        .navigationTitle("Light guide")
        .toolbarTitleDisplayMode(.inline)
    }
}
