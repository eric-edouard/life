import LifeConnector
import SwiftUI

/// Every read has the same five faces (brief rule 5): loading, empty, stale, unreachable, failed, and not paired. A screen gives only its
/// content and its empty and loading looks; the rest is here, so no screen draws a blank.
struct ReadScreen<Value: Sendable, Content: View, Loading: View, Empty: View>: View {
    let shown: ReadState<Value>.Shown
    /// When the read was asked and whether it runs, for the mark's Updating and out-of-date forms; nil: neither shows.
    var stamp: ReadStamp?
    /// Which mark this read draws: a part inside a page that marks itself draws none; home also tells the agents' trouble.
    var marks = Marks.reads
    let retry: () async -> Void
    /// What "Pair with Life" does: opens Settings, unless the screen is inside it (its Life page then).
    var pair: (() -> Void)?
    @ViewBuilder let loading: Loading
    @ViewBuilder let empty: Empty
    @ViewBuilder let content: (Value) -> Content

    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life

    var body: some View {
        // Each face fades out as the next fades in (loading to content: the spinner goes as the content comes).
        ZStack { face.appears(Motion.fade).id(shown.face) }
            // The network back: what is on show is read again, whatever screen it is.
            .onChange(of: life.hasPath) { _, hasPath in if hasPath { Task { await retry() } } }
    }

    /// How what shows stands against the Mac, in the toast over it (`SyncMark`).
    private func marked(_ shown: some View) -> some View {
        shown.syncMark(
            marks == .none ? nil : life.syncMark(self.shown, stamp: stamp, tellsAgents: marks == .readsAndAgents),
            retry: retry)
    }

    @ViewBuilder private var face: some View {
        switch shown {
        case .loading: loading
        // One branch for both, so the content is never made again as its read turns stale or fresh (`Shown.face`).
        case .loaded(let value), .stale(let value, _, _): marked(content(value))
        case .empty: marked(empty)
        case .unreachable:
            Notice(
                title: MacSilence.noAnswer + ".",
                detail: "Life runs on your Mac. This shows again once the phone reaches it.",
                action: ("Try again", { Task { await retry() } }))
        case .failed(let reason):
            Notice(title: "Life didn't answer.", detail: reason, action: ("Try again", { Task { await retry() } }))
        case .notPaired:
            Notice(
                title: "Not paired with Life.",
                detail: "Inbox and Projects need Life on your Mac.",
                action: ("Pair with Life", { if let pair { pair() } else { router.openSettings() } }))
        }
    }
}

/// Which mark a `ReadScreen` draws over what it shows.
enum Marks { case none, reads, readsAndAgents }

/// A calm full-screen message: what is so, in a few words, and the one thing to do about it.
struct Notice: View {
    let title: String
    let detail: String
    var action: (label: String, run: () -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Spacer()
            Text(title).font(.cardHeadline).foregroundStyle(Palette.fg)
            Text(detail).font(.body15).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            if let action {
                Button(action.label, action: action.run).buttonStyle(.pill(.quiet)).padding(.top, 8)
            }
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

extension View {
    /// An action control, off while Life is out of reach (`LifeStore.isOutOfReach`): the store refuses the tap anyway,
    /// and `ReadScreen` says why.
    func offWhileOutOfReach() -> some View { modifier(OffWhileOutOfReach()) }
}

private struct OffWhileOutOfReach: ViewModifier {
    @Environment(LifeStore.self) private var life
    func body(content: Content) -> some View { content.disabled(life.isOutOfReach) }
}

/// The sync mark (the design of 22 Nov): the designed `Toast` at the top of the pane, over what shows, which stays whole
/// under it; Retry in its capsule while a read can help, Show on the agents' trouble.
struct SyncNote: View {
    let mark: SyncMark
    let retry: () async -> Void
    @Environment(AppRouter.self) private var router
    @State private var isRetrying = false

    var body: some View {
        Toast(words: words, glyph: glyph, action: action ?? "", undo: action.map { _ in run })
            .padding(.horizontal, Metrics.gutter).padding(.top, Metrics.Spacing.s)
    }

    private var glyph: StateGlyph {
        switch mark {
        case .reconnecting, .updating: .busy
        case .old: .off
        default: isRetrying ? .busy : .flag
        }
    }

    private var words: String {
        switch mark {
        case .offline(let since): "No internet" + Self.asOf(since)
        case .macAway(let since): MacSilence.noAnswer + Self.asOf(since)
        case .reconnecting: "Reconnecting…"
        case .failed(let reason, let since): reason + Self.asOf(since)
        case .old(let since): "As of " + Self.time(since)
        case .updating: "Updating…"
        case .agents(.off): "Agents are off"
        case .agents(.notRunning): "Agents aren't running on your Mac"
        case .agents(.unreadable): "Agents can't be read"
        case .agents(.stalled(let count)): count == 1 ? "1 agent stalled" : "\(count) agents stalled"
        }
    }

    private var action: String? {
        switch mark {
        case .reconnecting, .updating: nil
        case .agents: "Show"
        default: "Retry"
        }
    }

    private func run() {
        if case .agents = mark { return router.show(.agents) }
        guard !isRetrying else { return }
        Task {
            isRetrying = true
            await retry()
            isRetrying = false
        }
    }

    /// " · as of 14:32", the time kept on one line with its words.
    private static func asOf(_ since: Date?) -> String { since.map { " · as\u{00A0}of\u{00A0}" + time($0) } ?? "" }

    /// The time today; a day before, its date too.
    static func time(_ at: Date) -> String {
        Calendar.current.isDateInToday(at)
            ? at.formatted(.dateTime.hour().minute()) : at.formatted(.dateTime.day().month().hour().minute())
    }
}

extension View {
    /// `mark` as the toast over the top of this pane, Updating and Reconnecting only after a second; nothing when nil.
    func syncMark(_ mark: SyncMark?, retry: @escaping () async -> Void) -> some View {
        modifier(SyncMarkOver(mark: mark, retry: retry))
    }
}

private struct SyncMarkOver: ViewModifier {
    let mark: SyncMark?
    let retry: () async -> Void
    @State private var shown: SyncMark?

    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            ZStack {
                if let shown { SyncNote(mark: shown, retry: retry).appears() }
            }
            .motion(Motion.standard, value: shown)
        }
        .task(id: mark) {
            // A read's own forms wait a second: the minute's read never flickers.
            if mark == .updating || mark == .reconnecting {
                guard (try? await Task.sleep(for: .seconds(1))) != nil else { return }
            }
            shown = mark
        }
    }
}
