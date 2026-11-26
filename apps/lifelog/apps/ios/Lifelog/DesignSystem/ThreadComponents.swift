import LifeConnector
import SwiftUI

// The thread's components (docs/design/chat-first/2026-11-25-app-v4-design-system.md): what the screens are built
// from. Pure views over plain values, no store: the catalog shows each in every state, and a screen only assembles.

/// A mark on a message: the rating's three marks, and 👀 for work handed on. Monotone in Life's interface (owner,
/// 26 Nov 2026). A reaction is never his OK and never `said`.
enum Reaction: String, CaseIterable {
    case handedOn = "👀"
    case down = "👎"
    case up = "👍"
    case delighted = "🤩"

    /// The three he gives: the rating's and a reaction's.
    static let rating: [Reaction] = [.down, .up, .delighted]
}

extension RatingMark {
    /// The wire's mark for each of the rating's three: 👎 is bad, 👍 is okay, 🤩 is good (delighted). The one mapping.
    static func of(_ reaction: Reaction) -> RatingMark {
        switch reaction {
        case .down: .bad
        case .up: .okay
        case .delighted: .good
        case .handedOn: .unknown
        }
    }
}

struct ReactionMark: View {
    let reaction: Reaction

    var body: some View {
        Text(reaction.rawValue).font(.line).saturation(0).accessibilityHidden(true)
    }
}

/// Life's thinking mark: three dots that rise in turn (still under Reduce Motion).
struct ThinkingMark: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric private var dot = 4.0

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: dot * 0.8) {
                ForEach(0..<3, id: \.self) { i in
                    Circle().fill(Palette.muted).frame(width: dot, height: dot)
                        .opacity(reduceMotion ? 0.7 : 0.35 + 0.65 * max(0, sin(t * 4 - Double(i) * 0.9)))
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// What Life is doing for his ask, one line: "Looking at your calendar" (the verb muted, its object bright, a muted
/// spinner), or the thinking mark and "Thinking…".
struct StepsLine: View {
    var verb: String?
    var what = ""

    var body: some View {
        HStack(spacing: Metrics.Spacing.s) {
            if let verb {
                Spinner(size: .small).foregroundStyle(Palette.muted)
                // The verb is muted and its object bright; the shimmer sweeps the verb.
                HStack(spacing: Metrics.Spacing.xs) {
                    ShimmerText(text: Text(verb))
                    Text(what).foregroundStyle(Palette.fg).fontWeight(.semibold).contentTransition(.opacity)
                }
                .font(.line)
            } else {
                ThinkingMark()
                ShimmerText(text: Text("Thinking…")).font(.line)
            }
        }
        .faces(verb ?? "")
        .motion(Motion.standard, value: what)
    }
}

extension View {
    /// An accessibility id for the end-to-end tests, when there is one. Never on a container: it overrides its children's.
    @ViewBuilder func identified(_ id: String?) -> some View {
        if let id { accessibilityIdentifier(id) } else { self }
    }
}

/// His words, a bubble on the right with Life's mark on it. `waiting` goes when he is back, `failed` is tapped to ask
/// again. A reaction sits on the bubble's bottom-left corner, outside the words.
struct HisBubble: View {
    enum State { case sent, waiting, failed }
    let words: String
    var state = State.sent
    var reaction: Reaction?
    /// A failed bubble is tapped to ask again.
    var retry: () -> Void = {}
    /// The widest bubble and the corner mark grow with the text size, so a large type still wraps and the mark keeps room.
    @ScaledMetric private var width = Metrics.bubbleWidth
    @ScaledMetric private var mark = Metrics.reactionMark

    var body: some View {
        Button(action: retry) {
            Text(words)
                .padding(.horizontal, Metrics.Spacing.m).padding(.vertical, Metrics.Spacing.s)
                .foregroundStyle(Palette.fg)
                .background(
                    Palette.tint,
                    in: UnevenRoundedRectangle(
                        topLeadingRadius: Metrics.Radius.block, bottomLeadingRadius: Metrics.Radius.block,
                        bottomTrailingRadius: Metrics.Radius.control / 2, topTrailingRadius: Metrics.Radius.block)
                )
        }
        .buttonStyle(.plain).disabled(state != .failed)
        .overlay(alignment: .bottomLeading) {
            if let reaction {
                ReactionMark(reaction: reaction).frame(width: mark, height: mark)
                    .background(Palette.card, in: .circle).offset(x: -Metrics.Spacing.s, y: mark / 2)
            }
        }
        .accessibilityHint(state == .failed ? "Not sent. Tap to try again" : "")
        // Half the mark hangs below the bubble: the rows under it start past it.
        .padding(.bottom, reaction == nil ? 0 : mark / 2 + Metrics.Spacing.xs)
        .frame(maxWidth: width, alignment: .trailing).frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.bottom, state == .waiting ? Metrics.Spacing.l : 0)
        .overlay(alignment: .bottomTrailing) {
            // Under the bubble, as the prototype's `.q`: a clock and when it goes.
            if state == .waiting {
                HStack(spacing: Metrics.Spacing.xs) {
                    Glyph(.clock, size: 13)
                    Text("when you're back")
                }
                .font(.meta).foregroundStyle(Palette.muted)
            }
        }
    }
}

/// A version he redrafted past: faded, above the one that replaced it.
struct EarlierDraftRow: View {
    let words: String

    var body: some View {
        VStack(alignment: .trailing, spacing: Metrics.Spacing.xs / 2) {
            Text("Earlier draft").font(.meta).foregroundStyle(Palette.faint)
            Text(words).font(.line).foregroundStyle(Palette.muted)
        }
        .frame(maxWidth: .infinity, alignment: .trailing).opacity(Metrics.Opacity.earlier)
    }
}

/// A long task's mark: a still ring in `muted` that fills at each milestone (docs/brand.md). It never turns, so it never
/// reads as a spinner (owner, 26 Nov 2026).
struct StillRing: View {
    /// 0 to 1.
    let progress: Double
    @ScaledMetric private var size = Metrics.pieSmall

    init(progress: Double, size: CGFloat = Metrics.pieSmall) {
        self.progress = progress
        _size = ScaledMetric(wrappedValue: size)
    }

    var body: some View {
        ZStack {
            Circle().stroke(Palette.muted.opacity(0.28), lineWidth: size * 0.16)
            Circle().trim(from: 0, to: max(progress, 0.06)).stroke(
                Palette.muted, style: StrokeStyle(lineWidth: size * 0.16, lineCap: .round)
            )
            .rotationEffect(.degrees(-90))
        }
        .padding(size * 0.08).frame(width: size, height: size).accessibilityLabel("Under way").accessibilityValue(
            Text(progress, format: .percent.precision(.fractionLength(0))))
    }
}

/// Where an item of the thread stands, as its row draws it. Held asks are not rows: they arrive under a
/// `HeldSeparator`.
enum ItemState: Hashable {
    case needsYou, later, waitingOnSomeone, settled, outdated, queued, stopped
    /// Life is looking for the step done (his "I paid it"): a spinner and its line, until it says.
    case looking
    /// Handed off: the pie's fill and the estimate ("About 20 min", then "About 10 min left").
    case underWay(progress: Double, estimate: String?)
    /// A send he undid: the outcome, in his words' place ("Deleted for both of you").
    case undone(String)

    /// Which state it is, whatever it carries: a change of kind is what the row shows (a progress tick is not).
    var kind: String {
        switch self {
        case .underWay: "underWay"
        case .undone: "undone"
        default: "\(self)"
        }
    }
}

/// Whose face an item has: a person's picture or initial (who asks), else a mark (a thing with no one behind it).
enum ItemFace: Equatable {
    case party(Party)
    case initial(String)
    /// A network's own mark (`NetworkMark`): a fix of a network that signed Life out.
    case network(String)
}

/// One item of the thread as a bare row that unfolds: its round face, the title, a line under it that says how it
/// stands (a settled one starts with a green tick); nothing trails it. Unfolded it is the same row, larger, with a fold
/// button, on a `wash` that fades out to the screen's edges (`washed`), with no dividers between rows.
struct ThreadItemRow<Detail: View>: View {
    let title: String
    let state: ItemState
    var icon = Glyph.Mark.doc
    /// A person's face, when someone asks; the `icon` mark otherwise.
    var face: ItemFace?
    /// What the row says under its title: "Jade · today", "Later · 9:00", why it went out of date.
    var line: String?
    var isOpen = false
    /// The ask's ref, when the row is a live ask: the end-to-end tests find its controls by it (`AID`).
    var ref: String?
    /// Puts a task off without opening it; nil on a row that has no such tap.
    var later: (() -> Void)?
    let toggle: () -> Void
    @ViewBuilder var detail: Detail
    /// The disc grows with the text size, so a mark or an initial stays inside it.
    @ScaledMetric private var disc = Metrics.disc
    @ScaledMetric private var askDisc = Metrics.askDisc

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            HStack(spacing: Metrics.Spacing.s) {
                Button(action: toggle) {
                    HStack(spacing: Metrics.Spacing.m) {
                        faceView
                        VStack(alignment: .leading, spacing: Metrics.Spacing.xs / 2) {
                            Text(title).font(isOpen ? .header : .rowTitle).multilineTextAlignment(.leading)
                            lineView
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        // A long title wraps before the fold button, never under it.
                        .padding(.trailing, isOpen ? Metrics.tapTarget : 0)
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: Metrics.tapTarget).contentShape(.rect)
                }
                .buttonStyle(.plain).identified(ref.map(AID.askRow))
                .accessibilityValue(state == .stopped ? "Stopped" : "")
                if state == .queued, let ref {
                    Color.clear.frame(width: 1, height: 1).accessibilityLabel("Goes when Life is back")
                        .accessibilityIdentifier(AID.askQueued(ref))
                }
                // A task's row puts it off in one tap, 32 high (the prototype's `.lt`).
                if let later, !isOpen {
                    Button("Later", action: later).font(.heading).foregroundStyle(Palette.muted)
                        .padding(.horizontal, Metrics.Spacing.m).frame(minHeight: 32)
                        .background(Palette.tint, in: .capsule).buttonStyle(.plain)
                }
            }
            if isOpen { detail }
        }
        .overlay(alignment: .topTrailing) {
            if isOpen {
                Button(action: toggle) {
                    Glyph(.fold, size: 16).foregroundStyle(Palette.muted)
                        .frame(width: Metrics.tapTarget * 0.7, height: Metrics.tapTarget * 0.7)
                        .background(Palette.tint, in: .circle)
                }
                .buttonStyle(.plain).accessibilityLabel("Fold")
            }
        }
        .opacity(state == .outdated ? Metrics.Opacity.faded : 1)
        .padding(.vertical, isOpen ? Metrics.Spacing.m : 0).washed(isOpen)
        .motion(Motion.standard, value: state.kind).motion(Motion.standard, value: line)
        .washes(on: state.kind)
    }

    /// The row's face, 40 pt (48 unfolded): who asks, else a mark.
    @ViewBuilder private var faceView: some View {
        let size = isOpen ? askDisc : disc
        Group {
            switch face {
            case .party(let party): Face(party: party, size: size)
            case .initial(let letter):
                Text(letter.uppercased()).font(isOpen ? .header : .rowTitle).foregroundStyle(Palette.muted)
            case .network(let network): NetworkMark(network: network, size: isOpen ? 24 : 22)
            case nil: Glyph(icon, size: isOpen ? 22 : 20).foregroundStyle(Palette.muted)
            }
        }
        .frame(width: size, height: size).background(Palette.tint, in: .circle).accessibilityHidden(true)
    }

    @ViewBuilder private var lineView: some View {
        switch state {
        case .underWay(let progress, let estimate):
            HStack(spacing: Metrics.Spacing.s) {
                StillRing(progress: progress, size: Metrics.pieSmall)
                Text(estimate ?? "Under way").font(.line).foregroundStyle(Palette.muted)
            }
        case .undone(let outcome):
            HStack(spacing: Metrics.Spacing.xs) {
                Glyph(.tick, size: 13).foregroundStyle(Palette.ok)
                Text(outcome).font(.line).foregroundStyle(Palette.muted)
            }
        case .stopped: Text("Stopped").font(.line).foregroundStyle(Palette.muted)
        case .looking:
            HStack(spacing: Metrics.Spacing.s) {
                Spinner(size: .small).foregroundStyle(Palette.muted)
                Text(line ?? "Looking…").font(.line).foregroundStyle(Palette.muted)
            }
        case .settled:
            HStack(spacing: Metrics.Spacing.xs) {
                Glyph(.tick, size: 13).foregroundStyle(Palette.ok)
                    .accessibilityLabel("Settled").identified(ref.map(AID.askSettled))
                if let line { Text(line).font(.line).foregroundStyle(Palette.muted) }
            }
        default: if let line { Self.coral(line).font(.line).foregroundStyle(Palette.muted).contentTransition(.opacity) }
        }
    }

    /// "Jade · today": the day is coral when it is today or tonight (owner, 26 Nov 2026).
    private static func coral(_ line: String) -> Text {
        line.components(separatedBy: " · ").enumerated().reduce(Text(verbatim: "")) { all, part in
            let (i, word) = part
            let piece = ["today", "tonight"].contains(word) ? Text(word).foregroundStyle(Palette.flag) : Text(word)
            return Text("\(all)\(i > 0 ? Text(" · ") : Text(verbatim: ""))\(piece)")
        }
    }
}

/// One quiet line over asks that were held (a meeting, a Focus, Sleep): "While you were in your meeting". Words only.
struct HeldSeparator: View {
    let text: String

    var body: some View {
        Text(text).font(.line).foregroundStyle(Palette.muted).multilineTextAlignment(.center).frame(
            maxWidth: .infinity)
    }
}

/// A send's line and its Undo: WhatsApp's "Sent to Lena", then what the other side will see before he confirms.
struct SentLine: View {
    enum Phase: Hashable { case sent(canUndo: Bool, until: String? = nil), confirming(String), undoing, undone }
    /// Who it went to; nil when the thread does not say.
    var to: String?
    let phase: Phase
    var undo: () -> Void = {}
    var keep: () -> Void = {}
    /// The Undo's id for the end-to-end tests (`AID.askUndo`).
    var undoID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            switch phase {
            case .sent(let canUndo, let until):
                HStack(spacing: Metrics.Spacing.xs) {
                    Glyph(.tick, size: 13).foregroundStyle(Palette.ok)
                    Text(to.map { "Sent to \($0)" } ?? "Sent").font(.line).foregroundStyle(Palette.muted)
                    if canUndo {
                        Button(until.map { "Undo until \($0)" } ?? "Undo", action: undo).font(.lineStrong)
                            .foregroundStyle(Palette.fg).identified(undoID)
                    }
                }
            case .confirming(let warning):
                Text(warning).font(.line).foregroundStyle(Palette.muted)
                HStack(spacing: Metrics.Spacing.s) {
                    Button("Delete for both", action: undo).buttonStyle(.pill(.filled, size: .compact)).identified(
                        undoID)
                    Button("Keep it", action: keep).buttonStyle(.pill(.quiet, size: .compact))
                }
            case .undoing:
                HStack(spacing: Metrics.Spacing.s) {
                    Spinner(size: .small).foregroundStyle(Palette.muted)
                    Text("Undoing…").font(.line).foregroundStyle(Palette.muted)
                }
            case .undone:
                HStack(spacing: Metrics.Spacing.xs) {
                    Glyph(.tick, size: 13).foregroundStyle(Palette.ok)
                    Text("Deleted for both of you").font(.line).foregroundStyle(Palette.muted)
                }
            }
        }
        .faces(phase)
    }
}

/// "How am I doing?": one quiet pill under a settled ask, its own row. A tap keeps the picked mark, says "Thanks" and
/// dims the row; the cross takes it away.
struct RatingRow: View {
    var question = "How am I doing?"
    /// The mark he gave: the others and the cross go, the row says "Thanks" and dims.
    var picked: Reaction?
    var pick: (Reaction) -> Void = { _ in }
    var close: () -> Void = {}
    /// A mark's id for the end-to-end tests.
    var identify: (Reaction) -> String? = { _ in nil }

    var body: some View {
        HStack(spacing: Metrics.Spacing.s) {
            Text(picked == nil ? question : "Thanks").font(.line).foregroundStyle(Palette.muted)
                .contentTransition(.opacity)
            Spacer(minLength: 0)
            ForEach(Reaction.rating, id: \.self) { mark in
                Button {
                    pick(mark)
                } label: {
                    ReactionMark(reaction: mark).frame(width: Metrics.ratingMark, height: Metrics.tapTarget)
                }
                .accessibilityLabel(mark.rawValue).identified(identify(mark))
                .scaleEffect(picked == mark ? 1.1 : 1).opacity(picked == nil || picked == mark ? 1 : 0)
                .disabled(picked != nil)
            }
            if picked == nil {
                Button(action: close) {
                    Glyph(.close, size: 14).foregroundStyle(Palette.faint).frame(
                        width: Metrics.ratingMark, height: Metrics.tapTarget)
                }
                .accessibilityLabel("Close")
            }
        }
        .buttonStyle(.plain).padding(.horizontal, Metrics.Spacing.l).background(Palette.card, in: .capsule)
        .opacity(picked == nil ? 1 : Metrics.Opacity.faded)
        .motion(Motion.standard, value: picked)
    }
}

/// An accessibility id only when there is one: an empty id would override the children's.
private struct OptionalID: ViewModifier {
    let id: String?
    @ViewBuilder func body(content: Content) -> some View {
        if let id { content.accessibilityIdentifier(id) } else { content }
    }
}

/// A notice at the top of the thread, shaped as a row: a round icon, the title, one muted line. Opened it shows what
/// to do about it in place (the settings block), never a button with a word (owner, 26 Nov 2026).
struct NoticeBlock<Detail: View>: View {
    let title: String
    var message: String?
    /// The trouble is over: a green tick leads its line (the notice settles where it stood).
    var isSettled = false
    var mark: Glyph.Mark?
    var isOpen = false
    var toggle: () -> Void = {}
    /// The tests' handle (`AID`), on the tap itself.
    var id: String?
    @ViewBuilder var detail: Detail
    /// The disc grows with the text size, so the mark stays inside it and inside the gutter.
    @ScaledMetric private var disc = Metrics.disc

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            Button(action: toggle) {
                HStack(spacing: Metrics.Spacing.m) {
                    Group {
                        if let mark { Glyph(mark, size: 20) } else { Image(systemName: "exclamationmark.circle") }
                    }
                    .font(.rowTitle).foregroundStyle(Palette.muted)
                    .frame(width: disc, height: disc).background(Palette.tint, in: .circle)
                    .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: Metrics.Spacing.xs / 2) {
                        Text(title).font(.rowTitle).multilineTextAlignment(.leading)
                        if let message {
                            HStack(spacing: Metrics.Spacing.xs) {
                                if isSettled { Glyph(.tick, size: 13).foregroundStyle(Palette.ok) }
                                Text(message).font(.line).foregroundStyle(Palette.muted)
                            }
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: Metrics.tapTarget).contentShape(.rect)
            }
            .buttonStyle(.plain)
            .modifier(OptionalID(id: id))
            if isOpen { detail }
        }
    }
}

extension NoticeBlock where Detail == EmptyView {
    init(title: String, message: String? = nil, isSettled: Bool = false, mark: Glyph.Mark? = nil) {
        self.init(title: title, message: message, isSettled: isSettled, mark: mark) { EmptyView() }
    }
}
