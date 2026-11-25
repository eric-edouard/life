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

struct ReactionMark: View {
    let reaction: Reaction

    var body: some View {
        Text(reaction.rawValue).font(.line).saturation(0).accessibilityHidden(true)
    }
}

/// His words, a bubble on the right with Life's mark on it. `waiting` goes when he is back, `failed` is tapped to ask
/// again. A reaction sits on the bubble's bottom-left corner, outside the words.
struct HisBubble: View {
    enum State { case sent, waiting, failed }
    let words: String
    var state = State.sent
    var reaction: Reaction?

    var body: some View {
        HStack(spacing: Metrics.Spacing.xs) {
            if state == .waiting {
                Image(systemName: "clock").font(.line).accessibilityLabel("Goes when you're back")
            }
            Text(words)
        }
        .padding(.horizontal, Metrics.Spacing.m).padding(.vertical, Metrics.Spacing.s).foregroundStyle(Palette.fg)
        .background(
            Palette.tint,
            in: UnevenRoundedRectangle(
                topLeadingRadius: Metrics.Radius.block, bottomLeadingRadius: Metrics.Radius.block,
                bottomTrailingRadius: Metrics.Radius.control / 2, topTrailingRadius: Metrics.Radius.block)
        )
        .overlay(alignment: .bottomLeading) {
            if let reaction {
                ReactionMark(reaction: reaction).frame(width: Metrics.reactionMark, height: Metrics.reactionMark)
                    .background(Palette.card, in: .circle).offset(x: -Metrics.Spacing.s, y: Metrics.Spacing.m)
            } else if state == .failed {
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Palette.flag).offset(
                    x: -Metrics.Spacing.s, y: Metrics.Spacing.s
                )
                .accessibilityLabel("Not sent. Tap to try again")
            }
        }
        .padding(.bottom, reaction == nil ? 0 : Metrics.Spacing.m)
        .frame(maxWidth: Metrics.bubbleWidth, alignment: .trailing).frame(maxWidth: .infinity, alignment: .trailing)
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

/// A long task's mark: a still pie in `muted` that fills at each milestone. It never turns, so it never reads as a
/// spinner (owner, 26 Nov 2026).
struct StillRing: View {
    /// 0 to 1.
    let progress: Double
    var size = Metrics.pie

    var body: some View {
        ZStack {
            Circle().fill(Palette.glass)
            Pie(fraction: max(progress, 0.06)).fill(Palette.muted)
        }
        .frame(width: size, height: size).accessibilityLabel("Under way").accessibilityValue(
            Text(progress, format: .percent.precision(.fractionLength(0))))
    }
}

/// A filled slice from 12 o'clock, clockwise.
private nonisolated struct Pie: Shape {
    let fraction: Double

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let centre = CGPoint(x: rect.midX, y: rect.midY)
        path.move(to: centre)
        path.addArc(
            center: centre, radius: rect.width / 2, startAngle: .degrees(-90),
            endAngle: .degrees(-90 + 360 * min(fraction, 1)), clockwise: false)
        path.closeSubpath()
        return path
    }
}

/// Where an item of the thread stands, as its row draws it. Held asks are not rows: they arrive under a
/// `HeldSeparator`.
enum ItemState: Equatable {
    case needsYou, later, waitingOnSomeone, settled, outdated, queued, stopped
    /// Handed off: the pie's fill and the estimate ("About 20 min", then "About 10 min left").
    case underWay(progress: Double, estimate: String?)
    /// A send he undid: the outcome, in his words' place ("Deleted for both of you").
    case undone(String)
}

/// One item of the thread as a bare row that unfolds: its round icon, the title, a line under it when the state has
/// one, its state's mark at the end; unfolded it sits on a `wash` that fades out to the screen's edges (`washed`), with no dividers between rows.
struct ThreadItemRow<Detail: View>: View {
    let title: String
    let state: ItemState
    var icon = "circle.dashed"
    var isOpen = false
    let toggle: () -> Void
    @ViewBuilder var detail: Detail

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            Button(action: toggle) {
                HStack(spacing: Metrics.Spacing.m) {
                    Image(systemName: icon).font(.rowTitle).foregroundStyle(Palette.muted)
                        .frame(width: Metrics.disc, height: Metrics.disc).background(Palette.tint, in: .circle)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: Metrics.Spacing.xs / 2) {
                        Text(title).font(isOpen ? .header : .rowTitle).multilineTextAlignment(.leading)
                        lineView
                    }
                    Spacer(minLength: 0)
                    mark
                }
                .frame(minHeight: Metrics.tapTarget).contentShape(.rect)
            }
            .buttonStyle(.plain)
            if isOpen { detail }
        }
        .opacity(state == .outdated ? Metrics.Opacity.faded : 1)
        .padding(.vertical, isOpen ? Metrics.Spacing.m : 0).washed(isOpen)
    }

    @ViewBuilder private var lineView: some View {
        switch state {
        case .underWay(let progress, let estimate):
            HStack(spacing: Metrics.Spacing.s) {
                StillRing(progress: progress, size: Metrics.pieSmall)
                Text(estimate ?? "Under way").font(.line).foregroundStyle(Palette.muted)
            }
        case .undone(let outcome): Text(outcome).font(.line).foregroundStyle(Palette.muted)
        case .stopped: Text("Stopped").font(.line).foregroundStyle(Palette.muted)
        default: EmptyView()
        }
    }

    @ViewBuilder private var mark: some View {
        switch state {
        case .needsYou:
            Circle().fill(Palette.flag).frame(width: Metrics.flagDot, height: Metrics.flagDot).accessibilityLabel(
                "Needs you")
        case .later: Image(systemName: "clock").foregroundStyle(Palette.muted).accessibilityLabel("Later")
        case .waitingOnSomeone:
            Image(systemName: "hourglass").foregroundStyle(Palette.muted).accessibilityLabel("Waiting on someone")
        case .settled, .undone: Image(systemName: "checkmark").foregroundStyle(Palette.ok).accessibilityLabel("Settled")
        case .queued:
            Image(systemName: "arrow.up.circle").foregroundStyle(Palette.muted).accessibilityLabel(
                "Goes when Life is back")
        case .stopped: Image(systemName: "stop.circle").foregroundStyle(Palette.muted).accessibilityLabel("Stopped")
        case .underWay, .outdated: EmptyView()
        }
    }
}

/// One quiet line over asks that were held (a meeting, a Focus, Sleep): "While you were in your meeting". Words only.
struct HeldSeparator: View {
    let text: String

    var body: some View {
        Text(text).font(.meta).foregroundStyle(Palette.faint).multilineTextAlignment(.center).frame(
            maxWidth: .infinity)
    }
}

/// A send's line and its Undo: WhatsApp's "Sent to Lena", then what the other side will see before he confirms.
struct SentLine: View {
    enum Phase: Equatable { case sent(undoUntil: String?), confirming(String), undoing, undone }
    let to: String
    let phase: Phase
    var undo: () -> Void = {}
    var keep: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            switch phase {
            case .sent(let until):
                HStack(spacing: Metrics.Spacing.xs) {
                    Text("Sent to \(to)").font(.line).foregroundStyle(Palette.muted)
                    if let until {
                        Button("Undo until \(until)", action: undo).font(.lineStrong).foregroundStyle(Palette.fg)
                    }
                }
            case .confirming(let warning):
                Text(warning).font(.line).foregroundStyle(Palette.muted)
                HStack(spacing: Metrics.Spacing.s) {
                    Button("Delete", action: undo).buttonStyle(.pill(.filled, size: .compact))
                    Button("Keep", action: keep).buttonStyle(.pill(.quiet, size: .compact))
                }
            case .undoing:
                HStack(spacing: Metrics.Spacing.s) {
                    Spinner(size: .small).foregroundStyle(Palette.muted)
                    Text("Undoing…").font(.line).foregroundStyle(Palette.muted)
                }
            case .undone:
                HStack(spacing: Metrics.Spacing.xs) {
                    Image(systemName: "checkmark").font(.lineStrong).foregroundStyle(Palette.ok)
                    Text("Deleted for both of you").font(.line).foregroundStyle(Palette.muted)
                }
            }
        }
    }
}

/// "How am I doing?": one quiet pill under an answered ask. A tap keeps the mark and the row fades; nothing follows.
struct RatingRow: View {
    var question = "How am I doing?"
    var pick: (Reaction) -> Void = { _ in }
    var close: () -> Void = {}

    var body: some View {
        HStack(spacing: Metrics.Spacing.s) {
            Text(question).font(.line).foregroundStyle(Palette.muted)
            Spacer(minLength: 0)
            ForEach(Reaction.rating, id: \.self) { mark in
                Button {
                    pick(mark)
                } label: {
                    ReactionMark(reaction: mark).frame(width: Metrics.ratingMark, height: Metrics.tapTarget)
                }
                .accessibilityLabel(mark.rawValue)
            }
            Button(action: close) {
                Image(systemName: "xmark").font(.line).foregroundStyle(Palette.faint).frame(
                    width: Metrics.ratingMark, height: Metrics.tapTarget)
            }
            .accessibilityLabel("Close")
        }
        .buttonStyle(.plain).padding(.horizontal, Metrics.Spacing.l).background(Palette.card, in: .capsule)
    }
}

/// A notice at the top of the thread, shaped as a row: a round icon, the title, one muted line. Opened it shows what
/// to do about it in place (the settings block), never a button with a word (owner, 26 Nov 2026).
struct NoticeBlock<Detail: View>: View {
    let title: String
    var message: String?
    var symbol = "exclamationmark.circle"
    var isOpen = false
    var toggle: () -> Void = {}
    /// The tests' handle (`AID`), on the tap itself.
    var id: String?
    @ViewBuilder var detail: Detail

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            Button(action: toggle) {
                HStack(spacing: Metrics.Spacing.m) {
                    Image(systemName: symbol).font(.rowTitle).foregroundStyle(Palette.muted)
                        .frame(width: Metrics.disc, height: Metrics.disc).background(Palette.tint, in: .circle)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: Metrics.Spacing.xs / 2) {
                        Text(title).font(.rowTitle).multilineTextAlignment(.leading)
                        if let message { Text(message).font(.line).foregroundStyle(Palette.muted) }
                    }
                    Spacer(minLength: 0)
                }
                .frame(minHeight: Metrics.tapTarget).contentShape(.rect)
            }
            .buttonStyle(.plain).accessibilityIdentifier(id ?? "")
            if isOpen { detail }
        }
    }
}

extension NoticeBlock where Detail == EmptyView {
    init(title: String, message: String? = nil, symbol: String = "exclamationmark.circle") {
        self.init(title: title, message: message, symbol: symbol, detail: { EmptyView() })
    }
}

/// A round control over the thread: one mark on Life's `glass` fill, no rim.
struct RoundButton: View {
    let symbol: String
    let label: String
    var badge: Int?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.bodyStrong).frame(width: Metrics.tapTarget, height: Metrics.tapTarget)
                .background(Palette.glass, in: .circle)
        }
        .buttonStyle(.plain).accessibilityLabel(label)
        .overlay(alignment: .topTrailing) {
            if let badge {
                Text("\(badge)").font(.metaStrong).foregroundStyle(Palette.on).padding(.horizontal, Metrics.Spacing.xs)
                    .frame(minWidth: Metrics.pie)
                    .background(Palette.flag, in: .capsule).accessibilityHidden(true)
            }
        }
    }
}
