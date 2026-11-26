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

    /// An entry of the thread, or an agent's late reply (with the entry it answers) landing where it arrived: at the
    /// bottom once it comes, led by a line that links back.
    private struct Row: Identifiable {
        let entry: ThreadEntry
        var origin: ThreadEntry?
        var id: UUID { entry.id }
    }

    private var rows: [Row] {
        let late = shown.flatMap { origin in
            (origin.entry.map { thread.lateReplies(to: $0) } ?? []).map { Row(entry: $0, origin: origin) }
        }
        return (shown.map { Row(entry: $0) } + late).enumerated()
            .sorted { ($0.element.entry.at, $0.offset) < ($1.element.entry.at, $1.offset) }.map(\.element)
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
                    let all = rows
                    ForEach(Array(all.enumerated()), id: \.element.id) { i, row in
                        let entry = row.entry
                        if i == 0 || !calendar.isDate(all[i - 1].entry.at, inSameDayAs: entry.at) {
                            Text(dayName(entry.at))
                                .font(.line).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                                .frame(maxWidth: .infinity).padding(.top, i == 0 ? 0 : Metrics.Spacing.s)
                                .accessibilityAddTraits(.isHeader)
                        }
                        if let origin = row.origin {
                            LateReplyView(late: entry, origin: origin, actions: actions) {
                                withAnimation(Motion.standard) { proxy.scrollTo(origin.id, anchor: .top) }
                            }
                        } else {
                            EntryView(
                                entry: entry, live: thread.live[entry.id], thread: thread, screen: screen,
                                actions: actions)
                        }
                    }
                    // An ask he was sent to (a notification, a link) that is no row above: Life brings it to the bottom,
                    // unfolded with its answers.
                    if let ask = life.focused.flatMap(life.ask), row(of: ask.ref) == nil {
                        ItemRow(ask: ask).id(ask.ref)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, Metrics.Spacing.l).padding(.top, Metrics.Spacing.l).padding(
                    // The prototype leaves 52 pt between the last answer and the field.
                    .bottom, Metrics.Spacing.xl + Metrics.Spacing.xs)
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
            .onScrollGeometryChange(for: Bool.self) {
                $0.visibleRect.maxY >= $0.contentSize.height - Metrics.listRow
            } action: {
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
            .onScrollGeometryChange(for: CGFloat.self) {
                $0.containerSize.height
            } action: { _, _ in
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
    private static let reactions = Reaction.rating.map(\.rawValue)
    @Environment(LifeStore.self) private var life

    /// The handed work still running: its pie fills with the time it has taken against its kind's median.
    private var underWay: [ThreadWireEntry.Handed] { (entry.handed ?? []).filter { $0.state == .underWay } }

    private func line(of work: ThreadWireEntry.Handed) -> (Double, String?) {
        guard let ms = work.estimateMs, let since = work.since else { return (0, nil) }
        let left = Double(ms) / 1000 - life.now().timeIntervalSince(since)
        let minutes = Int((max(left, Metrics.handedLeastSeconds) / 60).rounded(.up))
        let progress = min(max(1 - left / (Double(ms) / 1000), 0), Metrics.handedPieMost)
        // Before the first milestone it has only just begun: "About 20 min", then "About 10 min left".
        return (progress, progress < 0.1 ? "About \(minutes) min" : "About \(minutes) min left")
    }

    private func icon(of work: ThreadWireEntry.Handed) -> String {
        switch work.kind {
        case .booking: "calendar"
        case .lookup, .research: "magnifyingglass"
        case .reply, .redraft: "bubble.left"
        case .other, .unknown: "circle.dashed"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            // A tapped quick edit changes its draft in place: no bubble of its own.
            if entry.tap != true {
                HisBubble(
                    words: entry.words,
                    state: entry.phase == .waiting ? .waiting : entry.phase == .failed ? .failed : .sent,
                    reaction: entry.lifeReaction.flatMap(Reaction.init(rawValue:)),
                    retry: { thread.askAgain(entry.id, screen: screen) })
            }
            if let live {
                VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                    if let step = live.step {
                        StepsLine(verb: step.verb, what: step.what)
                    } else if live.parts.isEmpty {
                        StepsLine()
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
                if let mine = entry.ownerReaction.flatMap(Reaction.init(rawValue:)) { ReactionMark(reaction: mine) }
                ForEach(underWay, id: \.since) { work in
                    let (progress, estimate) = line(of: work)
                    ThreadItemRow(
                        title: entry.words, state: .underWay(progress: progress, estimate: estimate),
                        icon: icon(of: work),
                        undo: { thread.ask("Stop: \(entry.words)", screen: screen) }, toggle: {}
                    ) { EmptyView() }
                }
            } else if entry.phase == .failed {
                Text("I couldn't answer that.").foregroundStyle(Palette.muted)
            } else if entry.phase == .stopped {
                Text("Stopped").font(.line).foregroundStyle(Palette.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// An agent's late reply: a line that says what it answers and takes him back to it, then the reply.
private struct LateReplyView: View {
    let late: ThreadEntry
    let origin: ThreadEntry
    let actions: BlockActions
    let goBack: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            Button(action: goBack) {
                Text("About “\(origin.words)”:").font(.line).foregroundStyle(Palette.muted).lineLimit(2)
                    .multilineTextAlignment(.leading).underline()
            }
            .buttonStyle(.plain)
            if let text = late.answer {
                AnswerView(parts: AnswerPart.parts(of: text, sent: Set(late.checked)), actions: actions)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
