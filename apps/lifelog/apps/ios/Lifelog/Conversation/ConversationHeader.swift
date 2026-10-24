import Library
import SwiftUI
import Timeline

/// The top of the page: title (the owner's always wins), when and where, who spoke, and the summary folded to one
/// line. Unfolded, the summary shows in full with its chapters.
struct ConversationHeader: View {
    let store: ConversationStore
    let conversation: CachedConversation

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let title = store.title {
                Text(title).font(.readerTitle).foregroundStyle(Palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
            } else {
                Text(ConversationRow.untitledName(start: conversation.startAt)).font(.readerTitle).italic()
                    .foregroundStyle(Palette.textBody)
                    .accessibilityAddTraits(.isHeader)
            }
            if store.editWaiting {
                Label("Waiting to sync", systemImage: "arrow.triangle.2.circlepath")
                    .labelStyle(.decorativeIcon)
                    .font(.caption)
                    .foregroundStyle(Palette.textTertiary)
                    .padding(.top, 6)
            }
            facts.padding(.top, 8)
            speakers.padding(.top, 12)
            // With summaries off (the server's default) and none made before, there is no summary to show or wait for.
            if !store.lines.isEmpty, conversation.tldr != nil || !store.aiOff {
                SummaryCard(store: store, conversation: conversation).padding(.top, 14)
            }
        }
        .padding(.horizontal, 4)
        .padding(.bottom, 12)
    }

    /// "Today · 12:40–13:38 · 58m" and where it happened.
    private var facts: some View {
        let layout =
            typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 12))
        let when = Self.when(conversation.range)
        let duration = Duration.milliseconds(conversation.range.millis)
        return layout {
            // One text, so at large sizes it wraps as a sentence instead of as two squeezed columns.
            Text("\(when) · \(DurationText.string(duration, width: .narrow))")
                .font(.monoDetail)
                .accessibilityLabel("\(when), \(DurationText.string(duration, width: .wide))")
            if let place = conversation.place {
                PlaceLink(place: place)
                    .font(.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .multilineTextAlignment(.leading)
            }
        }
        .foregroundStyle(Palette.textSecondary)
    }

    /// One chip per speaker, in order of first words. Named people are solid; voices not linked to a person are dashed
    /// and never shown as confirmed. A chip opens the pills under the speaker's first passage.
    @ViewBuilder private var speakers: some View {
        let chips = speakerChips
        if !chips.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(chips, id: \.name) { chip in
                        Button {
                            store.naming = chip.line
                        } label: {
                            Text(chip.name)
                                .font(.footnote)
                                .foregroundStyle(chip.isPerson ? Palette.textPrimary : Palette.textSecondary)
                                .padding(.horizontal, 10)
                                .frame(minHeight: 28)
                                .background(chip.isPerson ? Palette.surface2 : .clear, in: .capsule)
                                .overlay {
                                    if !chip.isPerson {
                                        Capsule().strokeBorder(
                                            Palette.textTertiary, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                                    }
                                }
                                // The chip stays 28 pt; the tap target is 44.
                                .tapTarget()
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(chip.isPerson ? chip.name : "\(chip.name), not identified")
                        .accessibilityIdentifier("conversation.speaker")
                        .accessibilityHint("Name or correct this speaker")
                    }
                }
            }
            .scrollIndicators(.hidden)
            .scrollClipDisabled()
        }
    }

    private var speakerChips: [(name: String, isPerson: Bool, line: CachedTurn)] {
        var seen = Set<String>()
        return store.lines.compactMap { line in
            let name = line.speaker.displayName
            guard seen.insert(name).inserted else { return nil }
            return (name, store.isPerson(line), line)
        }
    }

    static func when(_ range: Range<CaptureInstant>) -> String {
        let start = range.lowerBound.date
        let calendar = Calendar.current
        let day =
            calendar.isDateInToday(start)
            ? "Today"
            : calendar.isDateInYesterday(start)
                ? "Yesterday" : start.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
        let time = Date.FormatStyle(date: .omitted, time: .shortened)
        return "\(day) · \(start.formatted(time))–\(range.upperBound.date.formatted(time))"
    }
}

/// The TLDR folded to one line; unfolded, the whole TLDR, chapters, each playable, and Regenerate.
/// Without one, why it waits; once all the words are in and nothing waits, Generate. The one place a summary is asked
/// for: never while summaries are off, and a request waiting to sync says so instead.
private struct SummaryCard: View {
    let store: ConversationStore
    let conversation: CachedConversation

    @Environment(PlaybackStore.self) private var playback
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let tldr = conversation.tldr {
                Button {
                    expanded.toggle()
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(
                            "\(Text("Summary · ").fontWeight(.semibold).foregroundStyle(Palette.textPrimary))\(tldr)"
                        )
                        .font(.subheadline)
                        .foregroundStyle(Palette.textBody)
                        .lineLimit(expanded ? nil : typeSize.isAccessibilitySize ? 3 : 1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.down")
                            .accessibilityHidden(true)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Palette.textTertiary)
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                    .padding(.vertical, 12)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                .accessibilityHint(expanded ? "Folds the summary" : "Shows the whole summary and chapters")
                if expanded {
                    details
                        .padding(.bottom, 12)
                        .transition(.opacity)
                }
            } else if let reason = conversation.waiting?.reason {
                Label(reason.sentence, systemImage: reason.systemImage)
                    .labelStyle(.decorativeIcon)
                    .font(.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 12)
            } else if store.state == .transcribed {
                HStack {
                    Text("No summary yet.").font(.subheadline).foregroundStyle(Palette.textSecondary)
                    Spacer()
                    summarize("Generate").font(.subheadline)
                }
                .padding(.vertical, 12)
            } else {
                Text("The summary comes once all the words are in.")
                    .font(.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 12)
            }
        }
        .padding(.horizontal, 14)
        .card(radius: Metrics.Radius.passage)
        .motion(Motion.standard, value: expanded)
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(store.chapters) { chapter in
                if let title = chapter.title {
                    jump(to: chapter.start, title: title, systemImage: "text.alignleft", hint: "chapter")
                }
            }
            summarize("Regenerate summary")
                .font(.footnote)
                .foregroundStyle(Palette.textSecondary)
                .padding(.top, 8)
        }
    }

    /// Asks the Mac for a summary; once asked, that it waits to sync. Nothing while summaries are off.
    @ViewBuilder private func summarize(_ title: String) -> some View {
        if store.summaryRequested {
            Label("Summary asked for · waiting to sync", systemImage: "arrow.triangle.2.circlepath")
                .labelStyle(.decorativeIcon)
                .foregroundStyle(Palette.textTertiary)
        } else if !store.aiOff {
            Button {
                Task { await store.summarize() }
            } label: {
                Label(title, systemImage: "sparkles").frame(minHeight: 44).contentShape(.rect)
            }
        }
    }

    private func jump(to instant: CaptureInstant, title: String, systemImage: String, hint: String) -> some View {
        let offset = conversation.range.lowerBound.distance(to: instant)
        return Button {
            store.play(playback, at: instant)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: systemImage)
                    .accessibilityHidden(true)
                    .foregroundStyle(Palette.textTertiary)
                    .imageScale(.small)
                Text(title).foregroundStyle(Palette.textPrimary)
                Spacer(minLength: 8)
                Text(PlayerClock.string(offset)).font(.monoSmall).foregroundStyle(Palette.textTertiary)
            }
            .font(.subheadline)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(PlayerClock.spoken(offset))")
        .accessibilityHint("Plays from this \(hint)")
    }
}
