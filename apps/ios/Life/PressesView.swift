import SwiftUI
import Timeline

/// The Pendant's button, looking back: each finished press by day, newest first (`ButtonActions.presses`), as a card
/// of the press overlay's family, with its own actions.
struct PressesView: View {
    @Environment(ButtonActions.self) private var buttons

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 12, pinnedViews: .sectionHeaders) {
                    ForEach(days, id: \.day) { day, presses in
                        Section {
                            ForEach(presses) { press in
                                PressCard(press: press)
                                    .padding(.horizontal, Metrics.gutter)
                                    .transition(.scale(scale: 0.94, anchor: .top).combined(with: .opacity))
                            }
                        } header: {
                            let title = DayTitle.parts(day)
                            SectionHeader(title: title.title, detail: title.detail).journalHeader()
                        }
                    }
                }
            }
            .background(Palette.ground)
            .overlay {
                if buttons.presses.isEmpty {
                    ContentUnavailableView {
                        Label {
                            Text("No presses yet").font(.cardTitle).foregroundStyle(Palette.textPrimary)
                        } icon: {
                            HALLens(light: .ember, diameter: 44).padding(.bottom, 12)
                        }
                    } description: {
                        Text(
                            "Press the Pendant’s button to ask an AI about the last minute."
                        )
                        .foregroundStyle(Palette.textSecondary)
                    }
                }
            }
            .motion(Motion.rise, value: buttons.presses)
            .tabTitle(
                "Presses",
                summary: buttons.presses.isEmpty
                    ? ""
                    : String(AttributedString(localized: "^[\(buttons.presses.count) press](inflect: true)").characters)
            )
            .connectionStatus()
        }
    }

    private var days: [(day: Date, presses: [PressRecord])] {
        Dictionary(grouping: buttons.presses) { Calendar.current.startOfDay(for: $0.at) }
            .map { ($0.key, $0.value) }
            .sorted { $0.day > $1.day }
    }
}

/// One press: the overlay's heading with its time, the words in Newsreader, the outcome, then its own glass actions.
private struct PressCard: View {
    let press: PressRecord
    @Environment(PlaybackStore.self) private var playback
    @State private var played = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            PressHeading(light: press.failure == nil ? .lit : .ember, at: press.at)
            if !press.text.isEmpty {
                Text(press.text)
                    .font(.spokenQuote)
                    .foregroundStyle(Palette.textPrimary)
                    .lineLimit(6)
                    .textSelection(.enabled)
            }
            if let failure = press.failure {
                Label(failure, systemImage: "exclamationmark.triangle.fill")
                    .labelStyle(.decorativeIcon)
                    .font(.footnote)
                    .foregroundStyle(Palette.redText)
            }
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    Button(action: play) { Image(systemName: "play.fill").frame(width: 20, height: 20) }
                        .accessibilityLabel("Play")
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                    if !press.text.isEmpty { AskButtons(words: press.text) }
                }
                .foregroundStyle(Palette.textPrimary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .card()
        .sensoryFeedback(.impact(weight: .light), trigger: played)
    }

    private func play() {
        played += 1
        let range = CaptureInstant(press.at.addingTimeInterval(-60))..<CaptureInstant(press.at)
        playback.open(id: UUID(), title: "Quick question", range: range, autoplay: true)
    }
}
