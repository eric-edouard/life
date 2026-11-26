import LifeConnector
import SwiftUI

/// The one endless conversation, opening clean (`OpeningScreen`, the app v4 prototype): his greeting, what is broken, at most
/// three asks that block him and a pill for the rest, then what he asks this sitting; Show earlier brings the thread back
/// a day at a time, with day separators, an earlier greeting kept only as its time.
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
    @State private var opening = OpeningScreen()
    /// The rest of the opening's asks, shown on the pill's tap.
    @State private var showsMore = false
    /// Whether he is reading at the end: only then does new text carry the view with it (his own scroll up is left alone).
    @State private var followsEnd = true
    @State private var isNearEnd = true
    /// Whether the rows fill the view: a short thread rests at the bottom by its anchors, and a scroll to the end would
    /// put the end under the field (the thread went blank while a slow answer wrote).
    @State private var isScrollable = false
    /// The rows he has seen: what comes after the first showing arrives with motion, the first showing does not.
    @State private var seenRows = 0
    /// When he opened the ask `life.opened`: while it still grows (its words, its answers), it is kept above the field.
    @State private var openedAt: Date?
    @Environment(\.calendar) private var calendar
    @Environment(\.scenePhase) private var scenePhase
    @Environment(LifeStore.self) private var life

    private var shown: [ThreadEntry] { thread.entries.filter { opening.isShown($0.at) } }

    /// An entry of the thread, or an agent's late reply (with the entry it answers) landing where it arrived: at the
    /// bottom once it comes, led by a line that links back.
    private struct Row: Identifiable {
        let entry: ThreadEntry
        var origin: ThreadEntry?
        var id: UUID { entry.id }
    }

    private var rows: [Row] {
        // A late reply shows by when it came, its ask shown or not.
        let late = thread.entries.flatMap { origin in
            (origin.entry.map { thread.lateReplies(to: $0) } ?? []).filter { opening.isShown($0.at) }
                .map { Row(entry: $0, origin: origin) }
        }
        return (shown.map { Row(entry: $0) } + late).enumerated()
            .sorted { ($0.element.entry.at, $0.offset) < ($1.element.entry.at, $1.offset) }.map(\.element)
    }

    /// Whether `entry`'s answer shows the ask `ref` as a row.
    private func holds(_ entry: ThreadEntry, _ ref: String) -> Bool {
        (thread.live[entry.id]?.parts ?? entry.answer.map { AnswerPart.parts(of: $0, sent: Set(entry.checked)) } ?? [])
            .contains { if case .block(.items(let refs)) = $0 { refs.contains(ref) } else { false } }
    }

    /// The entry whose answer already shows the ask `ref` as a row.
    private func row(of ref: String) -> UUID? { shown.first { holds($0, ref) }?.id }

    /// The opening's rows, live: each ask as Life last read it.
    private func asks(_ refs: [String]) -> [ThreadAsk] { refs.compactMap(life.ask) }

    /// The greeting, then what is broken (never capped), the asks that block him and the pill for the rest. Fix rows
    /// open in place (docs/product.md: what is broken comes first).
    @ViewBuilder private var openingRows: some View {
        let words = life.items.value?.owner.map { "Hi \($0)" } ?? "Hi"
        InkText(text: AttributedString(words)).font(.profileName).foregroundStyle(Palette.fg)
            // Inks in again at each opening (its own id); found by the scroll as the greeting.
            .environment(\.inksWords, true).id(opening.at).id(Self.greeting)
            .padding(.top, Metrics.Spacing.xs).accessibilityAddTraits(.isHeader)
        // Two blocks of rows, as an answer's `items` block lists them: what is broken, then the asks.
        rowBlock(opening.broken)
        rowBlock(opening.top + (showsMore ? opening.more : []))
        if !showsMore, !opening.more.isEmpty {
            Button {
                Motion.animate { showsMore = true }
            } label: {
                TintPill(title: "\(opening.more.count) more")
            }
            .buttonStyle(.plain).frame(maxWidth: .infinity).frame(minHeight: Metrics.tapTarget)
        }
    }

    private static let greeting = "greeting"

    @ViewBuilder private func rowBlock(_ refs: [String]) -> some View {
        if !refs.isEmpty {
            // 6 pt between rows, each with its own 10 above and below (the prototype's `rows2`).
            VStack(spacing: 6) {
                ForEach(asks(refs)) { ItemRow(ask: $0).id($0.ref).appears(Motion.arrives) }
            }
        }
    }

    /// A quiet line: a day, or an earlier greeting's time.
    private func mark(_ words: String) -> some View {
        Text(words).font(.line).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
            .frame(maxWidth: .infinity).accessibilityAddTraits(.isHeader)
    }

    /// A row of the thread, after its day's name when it starts a day (`previous`: the row before it, if any).
    @ViewBuilder private func rowView(_ row: Row, after previous: Date?, proxy: ScrollViewProxy) -> some View {
        let entry = row.entry
        if previous.map({ !calendar.isDate($0, inSameDayAs: entry.at) }) ?? true {
            mark(dayName(entry.at)).padding(.top, previous == nil ? 0 : Metrics.Spacing.s)
        }
        if let origin = row.origin {
            LateReplyView(late: entry, origin: origin, actions: actions) {
                Motion.animate { proxy.scrollTo(origin.id, anchor: .top) }
            }
            .appears(Motion.arrives)
        } else {
            EntryView(entry: entry, live: thread.live[entry.id], thread: thread, screen: screen, actions: actions)
                .appears(Motion.arrives)
        }
    }

    /// Earlier openings' greetings between `after` and `upTo`, kept only as their time.
    private func greetings(after: Date?, upTo: Date) -> [Date] {
        opening.earlierGreetings.filter { d in opening.isShown(d) && (after.map { d > $0 } ?? true) && d < upTo }
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
                    let dates = thread.entries.map(\.at)
                    if opening.earlierDay(of: dates, calendar: calendar) != nil {
                        Button {
                            // What was at the top stays where it is: the day before grows above it.
                            let top = rows.first?.id
                            opening.showEarlier(of: dates, calendar: calendar)
                            seenRows = 0
                            if let top { Task { proxy.scrollTo(top, anchor: .top) } }
                        } label: {
                            TintPill(title: "Show earlier")
                        }
                        .buttonStyle(.plain).frame(maxWidth: .infinity).frame(minHeight: Metrics.tapTarget)
                    }
                    let all = rows
                    let at = opening.at ?? .distantPast
                    let history = all.filter { $0.entry.at < at }
                    ForEach(Array(history.enumerated()), id: \.element.id) { i, row in
                        let previous = i == 0 ? nil : history[i - 1].entry.at
                        ForEach(greetings(after: previous, upTo: row.entry.at), id: \.self) { mark($0.clock) }
                        rowView(row, after: previous, proxy: proxy)
                    }
                    if opening.at != nil {
                        ForEach(greetings(after: history.last?.entry.at, upTo: at), id: \.self) { mark($0.clock) }
                        // Under what Show earlier brought back, this sitting starts at its day and time.
                        if let last = history.last?.entry.at {
                            if !calendar.isDate(last, inSameDayAs: at) { mark(dayName(at)) }
                            mark(at.clock)
                        }
                        openingRows
                    }
                    let sitting = all.filter { !($0.entry.at < at) }
                    ForEach(Array(sitting.enumerated()), id: \.element.id) { i, row in
                        rowView(row, after: i == 0 ? opening.at : sitting[i - 1].entry.at, proxy: proxy)
                    }
                    // An ask he was sent to (a notification, a link) that is no row above: Life brings it to the bottom,
                    // unfolded with its answers.
                    if let ask = life.focused.flatMap(life.ask), row(of: ask.ref) == nil,
                        !(opening.broken + opening.top + (showsMore ? opening.more : [])).contains(ask.ref)
                    {
                        ItemRow(ask: ask).id(ask.ref)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .motion(seenRows == 0 ? nil : Motion.rise, value: rows.map(\.id))
                .onChange(of: rows.count, initial: true) { seenRows = rows.count }
                .padding(.horizontal, Metrics.Spacing.l).padding(.top, Metrics.Spacing.l).padding(
                    // The prototype leaves 52 pt between the last answer and the field.
                    .bottom, Metrics.Spacing.xl + Metrics.Spacing.xs)
            }
            // A short thread rests just above the field: a safe-area padding, which the bottom anchor respects
            // (content margins are ignored for content shorter than the view).
            .safeAreaPadding(.bottom, fieldHeight)
            // The thread starts below the top bar and is cut there: nothing shows under the count or the buttons (the
            // prototype's `.thread`, `top` under the bar, `overflow: hidden`).
            .clipped()
            .padding(.top, topHeight)
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
                if followsEnd, isScrollable { proxy.scrollTo("end", anchor: .bottom) }
            }
            // The keyboard or the field growing shrinks the view from below: at the end, it stays at the end.
            .onChange(of: fieldHeight) { if followsEnd, isScrollable { proxy.scrollTo("end", anchor: .bottom) } }
            .onScrollGeometryChange(for: Bool.self) {
                $0.contentSize.height > $0.containerSize.height
            } action: { _, new in
                isScrollable = new
                // A short thread overflowing for the first time follows the end.
                if new, followsEnd { proxy.scrollTo("end", anchor: .bottom) }
            }
            // A growing answer follows the end, once there is something to scroll.
            .onChange(of: thread.live) { if followsEnd, isScrollable { proxy.scrollTo("end", anchor: .bottom) } }
            .onScrollGeometryChange(for: CGFloat.self) {
                $0.containerSize.height
            } action: { _, _ in
                if followsEnd, isScrollable { proxy.scrollTo("end", anchor: .bottom) }
            }
            // At launch, or back after five minutes away, the screen opens clean; back sooner, nothing changes.
            .onChange(of: scenePhase, initial: true) { _, phase in
                if phase == .background { opening.left(at: life.now()) }
                guard phase == .active, opening.came(at: life.now()) else { return }
                showsMore = false
                if let read = life.items.value { opening.take(read) }
                seenRows = 0
                Task { proxy.scrollTo(Self.greeting, anchor: .top) }
            }
            .onChange(of: life.items.value) { if let read = life.items.value { opening.take(read) } }
            // An ask he opens is brought fully into view above the field, once it has unfolded.
            .onChange(of: life.opened) {
                openedAt = life.opened == nil ? nil : life.now()
                guard let ref = life.opened else { return }
                Task {
                    try? await Task.sleep(for: .milliseconds(400))
                    Motion.animate { proxy.scrollTo(ref, anchor: .bottom) }
                }
            }
            // A card still growing after that (its clips, its people, an answer's words) is brought up again, so its
            // answers never stay under the field.
            .onScrollGeometryChange(for: CGFloat.self) {
                $0.contentSize.height
            } action: { old, new in
                guard new > old, let ref = life.opened, let openedAt, life.now().timeIntervalSince(openedAt) < 3
                else { return }
                proxy.scrollTo(ref, anchor: .bottom)
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
    @State private var showsReactions = false

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

    private func icon(of work: ThreadWireEntry.Handed) -> Glyph.Mark {
        switch work.kind {
        case .booking: .calendar
        case .lookup, .research: .pin
        case .reply, .redraft: .bubble
        case .other, .unknown: .doc
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
                    // The steps line blurs away where the words ink in.
                    if live.parts.isEmpty {
                        if let step = live.step {
                            StepsLine(verb: step.verb, what: step.what).appears(Motion.arrives)
                        } else {
                            StepsLine().appears(Motion.arrives)
                        }
                    }
                    AnswerView(parts: live.parts, actions: actions, isLive: true)
                }
                .motion(Motion.standard, value: live.step?.verb ?? (live.parts.isEmpty ? "thinking" : ""))
            } else if let answer = entry.answer {
                AnswerView(parts: AnswerPart.parts(of: answer, sent: Set(entry.checked)), actions: actions)
                    // A hold of 450 ms or a double tap: the three marks in a glass bar (the prototype's).
                    .onLongPressGesture(minimumDuration: 0.45) { Motion.animate { showsReactions = true } }
                    .onTapGesture(count: 2) { Motion.animate { showsReactions = true } }
                if showsReactions {
                    ReactionBar(reactions: Self.reactions) { e in
                        Motion.animate { showsReactions = false }
                        Task { await thread.react(entry.id, with: e) }
                    }
                    .transition(Motion.appears)
                }
                if let mine = entry.ownerReaction.flatMap(Reaction.init(rawValue:)) { ReactionMark(reaction: mine) }
                ForEach(underWay, id: \.since) { work in
                    let (progress, estimate) = line(of: work)
                    ThreadItemRow(
                        title: entry.words, state: .underWay(progress: progress, estimate: estimate),
                        icon: icon(of: work), toggle: {}
                    ) { EmptyView() }
                }
            } else if entry.phase == .failed {
                Text(entry.failure).foregroundStyle(Palette.muted)
            } else if entry.phase == .stopped {
                Text("Stopped").font(.line).foregroundStyle(Palette.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// An agent's late reply: his ask as a quiet line (it takes him back to it), then the reply.
private struct LateReplyView: View {
    let late: ThreadEntry
    let origin: ThreadEntry
    let actions: BlockActions
    let goBack: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            Button(action: goBack) {
                // His ask, as a quiet line above the reply: no bar, no label (the lab's A); a tap goes back to it.
                Text(origin.words).font(.line).foregroundStyle(Palette.muted).lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            .buttonStyle(.plain)
            if let text = late.answer {
                AnswerView(parts: AnswerPart.parts(of: text, sent: Set(late.checked)), actions: actions)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
