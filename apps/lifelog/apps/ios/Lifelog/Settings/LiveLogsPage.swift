import LifeConnector
import SwiftUI

/// The Live logs page's store, owned by the page: its feed (`LogFeed`, never cached, never in `LifeStore`: an old log
/// read as live would lie), read through `LifeStore.readLogLines`. One poller: `follow` reads the first page, then the
/// newest lines every 2 s; a filter or pairing change starts a new feed, and a read begun for an older one applies
/// nothing.
@MainActor @Observable
final class LiveLogs {
    /// Problems only (warn, error), or every line.
    var isProblems = false
    var process: LogProcess?
    private(set) var read = ReadState<LogFeed>()
    /// Lines that just came, tinted for 1 s.
    private(set) var tinted: Set<String> = []
    /// The feed a poll is under way for: one at a time (Retry and the loop share it).
    @ObservationIgnored private var polling: Int?
    /// The feed and cursor an older page is being read for: one at a time for each, so a read begun for another feed or
    /// cursor never holds up the one the list's end now asks.
    @ObservationIgnored private var loadingEarlier: String?
    /// Life did not answer since the last poll that read: the next one marks where it answered again ("Back at").
    @ObservationIgnored private var isGap = false
    /// Which feed a read was begun for: a read for an older one applies nothing.
    @ObservationIgnored private var feedNumber = 0

    var query: LogQuery { LogQuery(minLevel: isProblems ? .warn : nil, process: process) }

    /// Life did not answer the last read, or the pairing is gone: the lines shown are dimmed and following stops.
    var isDown: Bool {
        switch read.phase {
        case .unreachable, .failed, .notPaired: read.value != nil
        default: false
        }
    }

    /// The page's one poller, until it leaves or the filter or pairing changes (the page's `.task(id:)` cancels it).
    func follow(_ life: LifeStore) async {
        startOver()
        while !Task.isCancelled {
            await poll(life)
            try? await Task.sleep(for: .seconds(2))
        }
    }

    /// The newest lines: the first page, or every line written after the feed's head (the gap too, after Life did not
    /// answer).
    func poll(_ life: LifeStore) async {
        let (number, query) = (feedNumber, query)
        guard polling != number else { return }
        polling = number
        defer { if polling == number { polling = nil } }
        // Only the first try shows loading: a retry after a failure keeps its face until Life answers.
        if read.phase == .idle { read.apply(.started) }
        do {
            guard let shown = read.value else {
                read.apply(.succeeded(LogFeed(first: try await page(life, query, number)), Date()))
                return
            }
            // A feed cut at its top reads nothing new until he follows again, which starts it over.
            guard !shown.isCut else { return }
            let head = shown.head
            let new = try await LogFeed.newer(after: head) {
                try await self.page(life, query.after(head).before($0), number)
            }
            guard number == feedNumber, var feed = read.value, !feed.isCut else { return }
            let isShown = feed.isFollowing
            feed.add(newer: new, backAt: isGap ? Date() : nil)
            isGap = false
            read.apply(.succeeded(feed, Date()))
            if isShown { tint(new.lines.map(\.id)) }
        } catch let error as MCPError {
            fail(error, number)
        } catch {}
    }

    /// Older lines, while the list's end shows; a short page leaves the end in view, which loads the next.
    func loadEarlier(_ life: LifeStore) async {
        guard let cursor = read.value?.earlier else { return }
        let number = feedNumber
        let key = "\(number) \(cursor)"
        guard loadingEarlier != key else { return }
        loadingEarlier = key
        defer { if loadingEarlier == key { loadingEarlier = nil } }
        do {
            let page = try await page(life, query.before(cursor), number)
            guard var feed = read.value, feed.earlier == cursor else { return }
            feed.add(earlier: page)
            // Life answered: a failure shown before (and Follow held back by it) ends here too.
            read.apply(.succeeded(feed, Date()))
        } catch let error as MCPError {
            // A read for a cursor the feed has moved past says nothing about the feed now.
            if read.value?.earlier == cursor { fail(error, number) }
        } catch {}
    }

    private func fail(_ error: MCPError, _ number: Int) {
        guard number == feedNumber else { return }
        read.apply(.failed(error))
        if error != .cancelled, read.value != nil { isGap = true }
    }

    func pause() { change { $0.pause() } }

    /// Following again: what came while paused on top; a feed cut at its top starts over.
    func resume(_ life: LifeStore) async {
        guard read.value?.isCut == true else { return change { $0.follow() } }
        startOver()
        await poll(life)
    }

    private func startOver() {
        feedNumber += 1
        read = ReadState()
        tinted = []
        isGap = false
    }

    /// A change of the feed that is no read of Life: its phase stays (Life still answers, or still does not).
    private func change(_ body: (inout LogFeed) -> Void) {
        guard var feed = read.value else { return }
        body(&feed)
        read = read.showing(feed, at: Date())
    }

    /// One page for the feed `number`: none once another pairing or feed began (`CancellationError`).
    private func page(_ life: LifeStore, _ query: LogQuery, _ number: Int) async throws -> LogPage {
        guard let result = await life.readLogLines(query), number == feedNumber else { throw CancellationError() }
        return try result.get()
    }

    private func tint(_ ids: [String]) {
        tinted.formUnion(ids)
        Task {
            try? await Task.sleep(for: .seconds(1))
            tinted.subtract(ids)
        }
    }
}

/// Live logs (Settings, Help): a window onto what Life is doing on the Mac, for looking only. Newest on top, following
/// while at the top; scrolling down pauses, the pill or play follows again.
struct LiveLogsPage: View {
    /// Settings' Life page, for "Pair with Life".
    let pair: () -> Void
    @Environment(LifeStore.self) private var life
    @State private var logs = LiveLogs()
    @State private var position = ScrollPosition(edge: .top)
    @State private var opened: LogLine?

    var body: some View {
        VStack(spacing: Metrics.Spacing.m) {
            HStack(spacing: Metrics.Spacing.s) {
                LogLevelChoice(isProblems: $logs.isProblems)
                LogProcessMenu(process: $logs.process)
            }
            .padding(.horizontal, Metrics.gutter)
            ReadScreen(
                shown: logs.read.shown(isEmpty: \.isEmpty),
                retry: {
                    await logs.poll(life)
                    await logs.loadEarlier(life)
                },
                pair: pair,
                loading: { Spinner().foregroundStyle(Palette.fg).frame(maxHeight: .infinity) },
                empty: {
                    logs.isProblems
                        ? LogQuiet(text: "No problems in the last 24 hours", glyph: "checkmark.circle")
                        : LogQuiet(text: "Nothing yet. Lines show here as Life works.")
                },
                content: list)
        }
        .padding(.top, Metrics.Spacing.s)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Palette.sheet)
        .screenTitle("Live logs", state: logs.read.value?.isFollowing == true && !logs.isDown ? "Following" : nil)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                let isFollowing = logs.read.value?.isFollowing ?? true
                Button(isFollowing ? "Pause" : "Follow", systemImage: isFollowing ? "pause.fill" : "play.fill") {
                    isFollowing ? logs.pause() : follow()
                }
                .disabled(logs.isDown || logs.read.value == nil)
            }
        }
        .task(id: [AnyHashable(logs.query), AnyHashable(life.parties.generation.current)]) { await logs.follow(life) }
        .sheet(item: $opened) { LogLineSheet(line: $0) }
    }

    private func list(_ feed: LogFeed) -> some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                ForEach(feed.rows) { row in
                    switch row {
                    case .line(let line):
                        LogRow(line: line, isTinted: logs.tinted.contains(line.id)) { opened = line }
                            .transition(.move(edge: .top).combined(with: .opacity))
                    case .back(let at): LogBackRow(at: at)
                    }
                }
                if feed.earlier != nil || !feed.rows.isEmpty {
                    LogEndRow(isLoading: feed.earlier != nil)
                        .task(id: feed.earlier) { await logs.loadEarlier(life) }
                }
            }
            .padding(.horizontal, Metrics.Spacing.s)
            .motion(Motion.logLine, value: feed.rows.first?.id)
            .motion(Motion.standard, value: logs.tinted)
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.top, for: .sizeChanges)
        .onScrollGeometryChange(for: Bool.self) {
            $0.contentOffset.y + $0.contentInsets.top > Metrics.Spacing.xl
        } action: {
            wasDown, isDown in
            if isDown, !wasDown, logs.read.value?.isFollowing == true { logs.pause() }
        }
        .overlay(alignment: .top) {
            if !feed.isFollowing, feed.newCount > 0 {
                NewLinesPill(count: feed.newCount, action: follow).appears()
            }
        }
        .dimmed(logs.isDown)
    }

    /// Following again: what came while paused goes on top, and the list goes to the top.
    private func follow() {
        withAnimation(Motion.standard) { position.scrollTo(edge: .top) }
        Task { await logs.resume(life) }
    }
}

/// A line in full, for looking: its tag and category, the message wrapped, its time, and Copy.
private struct LogLineSheet: View {
    let line: LogLine
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                HStack(spacing: Metrics.Spacing.m) {
                    Text(
                        "\(Text(line.level.tag).fontWeight(.bold).foregroundStyle(line.level.color))  \(line.categoryWords)"
                    )
                    .font(.codeInline).foregroundStyle(Palette.fg).lineLimit(1)
                    Spacer(minLength: 0)
                    Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
                        UIPasteboard.general.string = line.copyText
                        copied = true
                        Task {
                            try? await Task.sleep(for: .seconds(1.5))
                            copied = false
                        }
                    }
                    .buttonStyle(.pill(.quiet, size: .compact)).fixedSize()
                    CloseButton { dismiss() }
                }
                Text(line.shownMessage).font(.codeInline).foregroundStyle(Palette.fg).textSelection(.enabled)
                RowGroup(surface: .sheet) {
                    Row(title: "Time") { Text(line.fullTime).font(.note).foregroundStyle(Palette.muted) }
                }
            }
            .padding(Metrics.gutter)
        }
        .background(Palette.sheet)
        .presentationDetents([.medium, .large])
    }
}
