import Capture
import PendantProtocol
import SwiftUI

/// The calm Pendant screen (docs/design.md, Pendant): a large HAL lens lit only by a confirmed
/// recording, one word under it with the sound line, Pause, then what needs the owner. Below the
/// fold, on solid surfaces: today's audio, battery and storage, and the audio still on the Pendant.
struct LensLayout<Attention: View>: View {
    let input: PendantLayoutInput
    @ViewBuilder let attention: Attention

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let glance = input.glance
        VStack(alignment: .leading, spacing: 12) {
            StatusHero(reading: input.hero, perform: input.actions.control, recover: input.actions.recover) {
                shown in
                LensHeader(reading: shown, since: input.capture.recordingSince, catchUp: catchUp)
            }
            .padding(.bottom, 8)
            attention
            GlanceGridLayout(columns: columns) {
                LensBattery(
                    level: glance.battery, caption: glance.batteryCaption, isLow: glance.batteryIsLow,
                    isCharging: glance.isCharging)
                LensStorage(storage: glance.storage)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 24)
    }

    private var columns: Int { typeSize.isAccessibilitySize ? 1 : 2 }

    /// A real catch-up: how far it is, and the audio still on the Pendant.
    private var catchUp: LensHeader.CatchUp? {
        guard case .catchingUp(let progress) = input.glance.sync, progress.expected > 0 else { return nil }
        return LensHeader.CatchUp(
            fraction: Double(min(progress.settled, progress.expected)) / Double(progress.expected),
            left: input.glance.backlog.value?.estimatedDuration)
    }
}

/// The lens and its word, the one line under it, and how long it has been recording.
private struct LensHeader: View {
    struct CatchUp {
        var fraction: Double
        var left: Duration?
    }

    let reading: HeroReading
    let since: Date?
    let catchUp: CatchUp?

    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isScrolling) private var isScrolling

    var body: some View {
        VStack(spacing: 0) {
            HALLens(
                light: light, hearing: reading.sound?.isHearing == true,
                progress: catchUp?.fraction,
                diameter: typeSize.isAccessibilitySize ? 150 : 196
            )
            .padding(.top, 22)
            WholeWords(reading.sentence, centered: true)
                .font(reading.voice == .word ? .statusWord : .matterTitle)
                .italic(reading.voice == .waiting)
                .foregroundStyle(reading.mode == .live ? Palette.fg : Palette.fg)
                .id(reading.sentence)
                .transition(.blurReplace(.upUp))
                .padding(.top, 30)
            if let line {
                Label {
                    EvidenceText(line: line.line)
                } icon: {
                    Image(systemName: line.systemImage)
                        // Still while scrolling: running, it redraws the whole screen every frame.
                        .symbolEffect(
                            .variableColor.iterative, isActive: line.isHearing && !reduceMotion && !isScrolling)
                }
                .font(.subheadline)
                .foregroundStyle(Palette.fg)
                .contentTransition(.opacity)
                .id(line.systemImage)
                .transition(.opacity)
                .padding(.top, 12)
            }
            if let since {
                Text(
                    "Mic on since \(since.moment) · \(Text(.currentDate, format: .offset(to: since, allowedFields: [.hour, .minute], sign: .never)))"
                )
                .font(.footnote)
                .foregroundStyle(Palette.faint)
                .padding(.top, 6)
            }
            if let left = catchUp?.left {
                Text(
                    "≈ \(Text(left, format: .units(allowed: [.hours, .minutes], width: .abbreviated))) of audio still on the Pendant"
                )
                .font(.footnote)
                .foregroundStyle(Palette.faint)
                .padding(.top, 6)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    }

    /// Lit only by a confirmed recording; an unconfirmed or stale state is dark glass.
    private var light: HALLens.Light {
        switch reading.mode {
        case .live: .lit
        case .paused: .ember
        case .lastKnownRecording, .unrecognized, .waiting, .notConnected: .dark
        }
    }

    /// A failure first, then what the microphones do, then the state's own evidence. The lit lens is the
    /// confirmation, so a fresh state never shows a counting "Confirmed 6 seconds ago".
    private var line: HeroReading.Glance? {
        if let failure = reading.failure {
            return HeroReading.Glance(line: .line(failure), systemImage: "exclamationmark.circle")
        }
        if let sound = reading.sound {
            return HeroReading.Glance(
                line: .line(sound.text), systemImage: sound.systemImage, isHearing: sound.isHearing)
        }
        return reading.summary
    }
}

extension View {
    /// A solid surface: content sits here, glass stays for the controls.
    fileprivate func lensCard(vertical: CGFloat = 16) -> some View {
        padding(.horizontal, 16)
            .padding(.vertical, vertical)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .card()
    }
}

/// A card's name over its figure.
private struct LensFact<Figure: View>: View {
    let title: String
    @ViewBuilder let figure: Figure

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.footnote)
                .foregroundStyle(Palette.muted)
            figure
        }
        .lensCard()
        .accessibilityElement(children: .combine)
    }
}

private struct LensBattery: View {
    let level: Fact<Int>
    let caption: String
    let isLow: Bool
    let isCharging: Bool

    var body: some View {
        LensFact(title: "Battery") {
            TileFigure(value: Text(level.value.map { "\($0) %" } ?? "—"), caption: caption, emphasis: isLow) {
                BatteryGlyph(percent: level.value, charging: isCharging, isCurrent: level.currentValue != nil)
            }
        }
    }
}

private struct LensStorage: View {
    let storage: Fact<StorageState>

    var body: some View {
        let state = storage.value.flatMap { $0.totalPages > 0 ? $0 : nil }
        let free = state.map { Double($0.freePages) / Double($0.totalPages) }
        LensFact(title: "Pendant storage") {
            TileFigure(
                value: Text(free.map { $0.formatted(.percent.precision(.fractionLength(0))) } ?? "—"),
                caption: caption, fraction: free.map { 1 - $0 })
        }
    }

    private var caption: String {
        switch storage {
        case .current: "Free"
        case .lastKnown(_, let at): "Free · last known \(at.moment)"
        case .unknown: "Never reported"
        }
    }
}
