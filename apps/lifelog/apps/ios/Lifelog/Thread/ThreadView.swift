import LifeConnector
import SwiftUI

/// The one endless conversation: opens at its bottom, day separators, Show earlier for what is older than three days.
struct ThreadView: View {
    let thread: LifeThread
    let screen: MainSessionScreen
    let actions: BlockActions
    var isPaired = true
    /// The buttons over the thread's top: it starts below them and fades out under them.
    var topHeight: CGFloat = 0
    /// The field that covers the thread's bottom: the last row rests above it. Kept as a margin on purpose: the
    /// safe-area inset alone left the last row under the field (the flow tests failed without it).
    var fieldHeight: CGFloat = 0
    @State private var showsEarlier = false
    /// Whether he is reading at the end: only then does new text carry the view with it (his own scroll up is left alone).
    @State private var followsEnd = true
    @State private var isNearEnd = true
    @Environment(\.calendar) private var calendar
    @Environment(LifeStore.self) private var life

    private var shown: [ThreadEntry] {
        let from = calendar.date(byAdding: .day, value: -3, to: thread.entries.last?.at ?? .now) ?? .distantPast
        return showsEarlier ? thread.entries : thread.entries.filter { $0.at >= from }
    }

    /// The entry whose answer already shows the ask `ref` as a row.
    private func row(of ref: String) -> UUID? {
        func holds(_ parts: [AnswerPart]) -> Bool {
            parts.contains { if case .block(.items(let refs)) = $0 { refs.contains(ref) } else { false } }
        }
        return shown.first { entry in
            holds(
                thread.live[entry.id]?.parts ?? entry.answer.map { AnswerPart.parts(of: $0, sent: Set(entry.checked)) }
                    ?? [])
        }?.id
    }

    /// Today and yesterday by name, else the weekday and date.
    private func dayName(_ day: Date) -> String {
        if calendar.isDateInToday(day) { return String(localized: "Today") }
        if calendar.isDateInYesterday(day) { return String(localized: "Yesterday") }
        return day.formatted(.dateTime.weekday(.wide).day().month())
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                    if shown.count < thread.entries.count {
                        Button("Show earlier") {
                            // What was at the top stays where it is: the older entries grow above it.
                            let top = shown.first?.id
                            showsEarlier = true
                            if let top { Task { proxy.scrollTo(top, anchor: .top) } }
                        }
                        .font(.heading).foregroundStyle(Palette.muted).frame(maxWidth: .infinity)
                        .frame(minHeight: Metrics.tapTarget)
                    }
                    ForEach(Array(shown.enumerated()), id: \.element.id) { i, entry in
                        if i == 0 || !calendar.isDate(shown[i - 1].at, inSameDayAs: entry.at) {
                            Text(dayName(entry.at))
                                .font(.line).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                                .frame(maxWidth: .infinity).padding(.top, i == 0 ? 0 : Metrics.Spacing.s)
                                .accessibilityAddTraits(.isHeader)
                        }
                        EntryView(
                            entry: entry, live: thread.live[entry.id], thread: thread, screen: screen, actions: actions)
                    }
                    // An ask he was sent to (a notification, a link) that is no row above: Life brings it to the bottom,
                    // unfolded with its answers.
                    if let ask = life.focused.flatMap(life.ask), row(of: ask.ref) == nil {
                        ItemRow(ask: ask).id(ask.ref)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, Metrics.Spacing.l).padding(.top, Metrics.Spacing.l).padding(.bottom, Metrics.Spacing.s)
            }
            .contentMargins(.top, topHeight, for: .scrollContent)
            .contentMargins(.bottom, fieldHeight, for: .scrollContent)
            .mask(alignment: .top) {
                VStack(spacing: 0) {
                    LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                        .frame(height: topHeight)
                    Rectangle()
                }
            }
            .defaultScrollAnchor(.bottom)
            // The keyboard shrinks the thread from below: its bottom stays where it was.
            .defaultScrollAnchor(.bottom, for: .sizeChanges)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { $0.visibleRect.maxY >= $0.contentSize.height - Metrics.listRow } action: {
                isNearEnd = $1
            }
            // A drag that ends away from the end stops following; one that ends at it follows again. Growth never counts.
            .onScrollPhaseChange { old, new in
                if new == .idle, old == .interacting || old == .decelerating { followsEnd = isNearEnd }
            }
            // His own ask goes to the end whatever he was reading; a late reply or a new card only when he is there.
            .onChange(of: thread.entries.count) {
                if thread.entries.last?.phase == .sending { followsEnd = true }
                if followsEnd { proxy.scrollTo("end", anchor: .bottom) }
            }
            // The keyboard or the field growing shrinks the view from below: at the end, it stays at the end.
            .onChange(of: fieldHeight) { if followsEnd { proxy.scrollTo("end", anchor: .bottom) } }
            .onScrollGeometryChange(for: CGFloat.self) { $0.containerSize.height } action: { _, _ in
                if followsEnd { proxy.scrollTo("end", anchor: .bottom) }
            }
            .onChange(of: life.focused) {
                guard let ref = life.focused else { return }
                // On screen already: scroll to its row (it unfolds itself); else it was brought to the bottom.
                if let id = row(of: ref) {
                    proxy.scrollTo(id, anchor: .center)
                } else {
                    proxy.scrollTo("end", anchor: .bottom)
                }
            }
            .onChange(of: thread.live) { if followsEnd { proxy.scrollTo("end", anchor: .bottom) } }
        }
    }
}

/// His words, and under them what Life does and says.
private struct EntryView: View {
    let entry: ThreadEntry
    let live: LiveAnswer?
    let thread: LifeThread
    let screen: MainSessionScreen
    let actions: BlockActions
    private static let reactions = ["👍", "❤️", "😂", "🙏"]
    /// His bubble's widest: the design's, grown with the text size so a large type still wraps in a bubble.
    @ScaledMetric private var bubbleWidth = Metrics.bubbleWidth

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            bubble
            if let live {
                VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                    if let step = live.step {
                        HStack(spacing: Metrics.Spacing.s) {
                            Spinner(size: .small).foregroundStyle(Palette.ai)
                            Text("\(step.verb) \(step.what)").font(.line).foregroundStyle(Palette.muted)
                        }
                    } else if live.parts.isEmpty {
                        Spinner(size: .small).foregroundStyle(Palette.ai)
                    }
                    AnswerView(parts: live.parts, actions: actions)
                }
            } else if let answer = entry.answer {
                AnswerView(parts: AnswerPart.parts(of: answer, sent: Set(entry.checked)), actions: actions)
                    .contextMenu {
                        ForEach(Self.reactions, id: \.self) { e in
                            Button(e) { Task { await thread.react(entry.id, with: e) } }
                        }
                    }
                if let mine = entry.ownerReaction {
                    Text(mine).font(.line).padding(.horizontal, Metrics.Spacing.s).background(
                        Palette.tint, in: .capsule)
                }
            } else if entry.phase == .failed {
                Text("I couldn't answer that.").foregroundStyle(Palette.muted)
            } else if entry.phase == .stopped {
                Text("Stopped").font(.line).foregroundStyle(Palette.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var bubble: some View {
        Button {
            thread.askAgain(entry.id, screen: screen)
        } label: {
            HStack(spacing: Metrics.Spacing.xs) {
                if entry.phase == .waiting {
                    Image(systemName: "clock").font(.line).accessibilityLabel("Goes when you're back")
                }
                Text(entry.words)
                if let emoji = entry.lifeReaction { Text(emoji).font(.line) }
            }
            .padding(.horizontal, Metrics.Spacing.m).padding(.vertical, Metrics.Spacing.s).foregroundStyle(Palette.fg)
            .background(
                Palette.tint,
                in: UnevenRoundedRectangle(
                    topLeadingRadius: Metrics.Radius.block, bottomLeadingRadius: Metrics.Radius.block,
                    bottomTrailingRadius: Metrics.Radius.control / 2, topTrailingRadius: Metrics.Radius.block)
            )
        }
        .buttonStyle(.plain).disabled(entry.phase != .failed)
        .frame(maxWidth: bubbleWidth, alignment: .trailing).frame(maxWidth: .infinity, alignment: .trailing)
    }
}
