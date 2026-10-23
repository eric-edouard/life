import Capture
import PendantProtocol
import SwiftUI

/// The calm Pendant screen (docs/design.md, Pendant): a large HAL lens lit only by a confirmed
/// recording, one word under it with the sound line, Pause and the scissors, then what needs the owner. Below the
/// fold, on solid surfaces: today's audio and spending, battery and storage, and the audio still on the Pendant.
struct LensLayout<Attention: View>: View {
    let input: PendantLayoutInput
    @ViewBuilder let attention: Attention

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let glance = input.glance
        VStack(alignment: .leading, spacing: 12) {
            StatusHero(
                reading: input.hero, perform: input.actions.control, recover: input.actions.recover,
                split: input.split
            ) { shown in
                LensHeader(reading: shown, since: input.capture.recordingSince, catchUp: catchUp)
            }
            .padding(.bottom, 8)
            attention
            LensSection("Today")
            GlanceGridLayout(columns: columns) {
                LensSaved(today: glance.today)
                LensSpent(spending: glance.spending, isPaired: glance.isPaired)
                LensBattery(
                    level: glance.battery, caption: glance.batteryCaption, isLow: glance.batteryIsLow,
                    isCharging: glance.isCharging)
                LensStorage(storage: glance.storage)
                LensBacklog(facts: glance)
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
    /// A press at work brightens the lens and runs its ring with the overlay's stages.
    @Environment(ButtonActions.self) private var buttons: ButtonActions?

    var body: some View {
        let press = buttons?.shown.flatMap { $0.ended ? nil : $0 }
        VStack(spacing: 0) {
            HALLens(
                light: light, hearing: reading.sound?.isHearing == true || press != nil,
                progress: catchUp?.fraction ?? press?.progress,
                diameter: typeSize.isAccessibilitySize ? 150 : 196
            )
            .padding(.top, 22)
            WholeWords(reading.sentence, centered: true)
                .font(reading.voice == .word ? .statusWord : .statusSentence)
                .italic(reading.voice == .waiting)
                .foregroundStyle(reading.mode == .live ? Palette.textPrimary : Palette.textBody)
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
                .foregroundStyle(Palette.textBody)
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
                .foregroundStyle(Palette.textTertiary)
                .padding(.top, 6)
            }
            if let left = catchUp?.left {
                Text(
                    "≈ \(Text(left, format: .units(allowed: [.hours, .minutes], width: .abbreviated))) of audio still on the Pendant"
                )
                .font(.footnote)
                .foregroundStyle(Palette.textTertiary)
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

private struct LensSection: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .font(.title3.weight(.semibold))
            .foregroundStyle(Palette.textPrimary)
            .padding(.top, 20)
            .padding(.horizontal, 4)
            .accessibilityAddTraits(.isHeader)
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
                .foregroundStyle(Palette.textSecondary)
            figure
        }
        .lensCard()
        .accessibilityElement(children: .combine)
    }
}

private struct LensSaved: View {
    let today: SavedToday?

    var body: some View {
        LensFact(title: "Saved") {
            TileFigure(
                value: today.map {
                    Text(
                        $0.recorded,
                        format: .units(allowed: [.hours, .minutes], width: .narrow, zeroValueUnits: .show(length: 1)))
                } ?? Text("—"),
                caption: today.map {
                    String(AttributedString(localized: "^[\($0.conversations) conversation](inflect: true)").characters)
                } ?? "Library not open yet")
        }
    }
}

/// Opens the Spending sheet.
private struct LensSpent: View {
    let spending: TranscriptionFacts.Spending?
    let isPaired: Bool

    @State private var showsSheet = false

    var body: some View {
        Button {
            showsSheet = true
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Spent")
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.forward")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Palette.textTertiary)
                        .accessibilityHidden(true)
                }
                .font(.footnote)
                .foregroundStyle(Palette.textSecondary)
                SpendingFigure(spending: spending, isPaired: isPaired)
            }
            .lensCard()
            .contentShape(.rect(cornerRadius: Metrics.Radius.card))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens spending.")
        .accessibilityIdentifier("pendant.lens.spent")
        .sheet(isPresented: $showsSheet) { SpendingSheet() }
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

/// Audio still on the Pendant, in time rather than pages, counting down while it catches up.
private struct LensBacklog: View {
    let facts: GlanceFacts

    var body: some View {
        LensFact(title: "On the Pendant") { figure }
            .accessibilityIdentifier("pendant.lens.backlog")
    }

    private var figure: TileFigure<EmptyView> {
        let estimate = facts.backlog.value?.estimatedDuration
        if case .catchingUp(let progress) = facts.sync, progress.expected > 0 {
            let done = Double(min(progress.settled, progress.expected)) / Double(progress.expected)
            return TileFigure(
                value: Text(estimate.map { Self.hoursMinutes($0 * (1 - done)) } ?? "—"),
                caption: "\(done.formatted(.percent.precision(.fractionLength(0)))) brought over", fraction: done)
        }
        if !facts.isConnected { return TileFigure(value: Text("?"), caption: "Grows meanwhile") }
        guard let backlog = facts.backlog.value else { return TileFigure(value: Text("—"), caption: "Checking…") }
        if backlog.pages == 0 { return TileFigure(value: Text(Self.hoursMinutes(.zero)), caption: "All here") }
        return TileFigure(value: Text(estimate.map(Self.hoursMinutes) ?? "—"), caption: "To bring over")
    }

    /// "0m", "8m", "4h 12m".
    private static func hoursMinutes(_ duration: Duration) -> String {
        let units: Set<Duration.UnitsFormatStyle.Unit> = duration < .seconds(3_600) ? [.minutes] : [.hours, .minutes]
        return duration.formatted(.units(allowed: units, width: .narrow, zeroValueUnits: .show(length: 1)))
    }
}
