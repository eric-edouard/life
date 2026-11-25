import LifeConnector
import SwiftUI

/// The one endless conversation: opens at its bottom, day separators, Show earlier for what is older than three days.
struct ThreadView: View {
    let thread: LifeThread
    let screen: MainSessionScreen
    let actions: BlockActions
    var isPaired = true
    /// The field that covers the thread's bottom: the last row rests above it, and stays there as words stream in.
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

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
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
                            Text(entry.at.formatted(.dateTime.weekday(.wide).day().month()))
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
                .padding(.horizontal, Metrics.threadGutter).padding(.vertical, Metrics.Spacing.l)
            }
            .overlay { if thread.entries.isEmpty && !thread.isWorking { EmptyThread() } }
            .contentMargins(.bottom, fieldHeight, for: .scrollContent)
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
            .onChange(of: thread.entries.count) {
                followsEnd = true
                proxy.scrollTo("end", anchor: .bottom)
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

/// A thread with nothing in it yet: one quiet line where the first words will land.
private struct EmptyThread: View {
    var body: some View {
        Text("Ask me anything.").font(.body15).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
            .padding(Metrics.gutter).allowsHitTesting(false)
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
