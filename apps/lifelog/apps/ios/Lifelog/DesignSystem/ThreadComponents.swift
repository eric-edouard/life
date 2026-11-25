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
/// again.
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
            if let reaction { ReactionMark(reaction: reaction) }
        }
        .padding(.horizontal, Metrics.Spacing.m).padding(.vertical, Metrics.Spacing.s).foregroundStyle(Palette.fg)
        .background(
            Palette.tint,
            in: UnevenRoundedRectangle(
                topLeadingRadius: Metrics.Radius.block, bottomLeadingRadius: Metrics.Radius.block,
                bottomTrailingRadius: Metrics.Radius.control / 2, topTrailingRadius: Metrics.Radius.block)
        )
        .overlay(alignment: .bottomLeading) {
            if state == .failed {
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Palette.flag).offset(x: -6, y: 6)
                    .accessibilityLabel("Not sent. Tap to try again")
            }
        }
        .frame(maxWidth: 300, alignment: .trailing).frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// A version he redrafted past: faded, above the one that replaced it.
struct EarlierDraftRow: View {
    let words: String

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text("Earlier draft").font(.meta).foregroundStyle(Palette.faint)
            Text(words).font(.line).foregroundStyle(Palette.muted)
        }
        .frame(maxWidth: .infinity, alignment: .trailing).opacity(0.6)
    }
}

/// A long task's mark: a still ring that fills at each milestone, never a spinner.
struct StillRing: View {
    /// 0 to 1.
    let progress: Double
    var size: CGFloat = 18

    var body: some View {
        ZStack {
            Circle().stroke(Palette.tint, lineWidth: 2)
            Circle().trim(from: 0, to: max(progress, 0.04)).stroke(
                Palette.ai, style: .init(lineWidth: 2, lineCap: .round)
            )
            .rotationEffect(.degrees(-90))
        }
        .frame(width: size, height: size).accessibilityLabel("Under way").accessibilityValue(
            Text(progress, format: .percent.precision(.fractionLength(0))))
    }
}

/// Where an item of the thread stands, as its row draws it. Held asks are not rows: they arrive under a
/// `HeldSeparator`.
enum ItemState: Equatable {
    case needsYou, later, waitingOnSomeone, settled, outdated, queued, stopped
    /// Handed off: the ring's fill and the estimate ("About 20 min", then "About 10 min left").
    case underWay(progress: Double, estimate: String?)
    /// A send he undid: the outcome, in his words' place ("Deleted for both of you").
    case undone(String)
}

/// One item of the thread as a row that unfolds: title, its state's mark at the end, a line under it when the state
/// has one, and the unfolded `detail` on a `wash`.
struct ThreadItemRow<Detail: View>: View {
    let title: String
    let state: ItemState
    var isOpen = false
    let toggle: () -> Void
    @ViewBuilder var detail: Detail

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            Button(action: toggle) {
                HStack(spacing: Metrics.Spacing.m) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(isOpen ? .header : .rowTitle).foregroundStyle(titleColor)
                            .strikethrough(state == .outdated).multilineTextAlignment(.leading)
                        if let line { Text(line).font(.line).foregroundStyle(Palette.muted) }
                    }
                    Spacer(minLength: 0)
                    mark
                }
                .frame(minHeight: Metrics.tapTarget).contentShape(.rect)
            }
            .buttonStyle(.plain)
            if isOpen { detail }
            Hairline()
        }
        .padding(.horizontal, isOpen ? Metrics.Spacing.m : 0)
        .background(isOpen ? Palette.wash : .clear, in: .rect(cornerRadius: Metrics.Radius.block))
    }

    private var titleColor: Color { state == .outdated || state == .stopped ? Palette.faint : Palette.fg }

    private var line: String? {
        switch state {
        case .underWay(_, let estimate): estimate
        case .undone(let outcome): outcome
        case .stopped: "Stopped"
        default: nil
        }
    }

    @ViewBuilder private var mark: some View {
        switch state {
        case .needsYou:
            Image(systemName: "circle.fill").font(.metaStrong).foregroundStyle(Palette.flag).accessibilityLabel(
                "Needs you")
        case .later: Image(systemName: "clock").foregroundStyle(Palette.muted).accessibilityLabel("Later")
        case .underWay(let progress, _): StillRing(progress: progress)
        case .waitingOnSomeone:
            Image(systemName: "hourglass").foregroundStyle(Palette.muted).accessibilityLabel("Waiting on someone")
        case .settled, .undone: Image(systemName: "checkmark").foregroundStyle(Palette.ok).accessibilityLabel("Settled")
        case .queued:
            Image(systemName: "arrow.up.circle").foregroundStyle(Palette.muted).accessibilityLabel(
                "Goes when Life is back")
        case .stopped: Image(systemName: "stop.circle").foregroundStyle(Palette.muted).accessibilityLabel("Stopped")
        case .outdated: EmptyView()
        }
    }
}

/// One quiet separator over asks that were held (a meeting, a Focus, Sleep): "While you were in your meeting".
struct HeldSeparator: View {
    let text: String

    var body: some View {
        HStack(spacing: Metrics.Spacing.m) {
            Hairline()
            Text(text).font(.meta).foregroundStyle(Palette.faint).fixedSize()
            Hairline()
        }
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
                    StillRing(progress: 0.3, size: 14)
                    Text("Undoing…").font(.line).foregroundStyle(Palette.muted)
                }
            case .undone: Text("Deleted for both of you").font(.line).foregroundStyle(Palette.ok)
            }
        }
    }
}

/// "How am I doing?": one quiet row under an answered ask. A tap keeps the mark and the row fades; nothing follows.
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
                    ReactionMark(reaction: mark).frame(width: 36, height: Metrics.tapTarget)
                }
                .accessibilityLabel(mark.rawValue)
            }
            Button(action: close) {
                Image(systemName: "xmark").font(.line).foregroundStyle(Palette.faint).frame(
                    width: 36, height: Metrics.tapTarget)
            }
            .accessibilityLabel("Close")
        }
        .buttonStyle(.plain)
    }
}

/// A notice at the top of the thread: a title, and when it opens a body and the one thing to do ("Your Mac isn't
/// answering", then "Settings"). `isBack` is the quiet line after it passes.
struct NoticeBlock: View {
    let title: String
    var message: String?
    var action: String?
    var isOpen = false
    var toggle: () -> Void = {}
    var act: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            Button(action: toggle) {
                Text(title).font(.rowTitle).frame(maxWidth: .infinity, alignment: .leading).frame(
                    minHeight: Metrics.tapTarget
                )
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if isOpen {
                if let message { Text(message).font(.line).foregroundStyle(Palette.muted) }
                if let action { Button(action, action: act).buttonStyle(.pill(.quiet, size: .compact)) }
            }
        }
        .padding(.horizontal, Metrics.Spacing.l).padding(.bottom, isOpen ? Metrics.Spacing.m : 0).card()
    }
}

/// A round control over the thread: the system's glass circle with one mark.
struct RoundButton: View {
    let symbol: String
    let label: String
    var badge: Int?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.bodyStrong).frame(width: Metrics.tapTarget, height: Metrics.tapTarget)
        }
        .buttonStyle(.glass).buttonBorderShape(.circle).accessibilityLabel(label)
        .overlay(alignment: .topTrailing) {
            if let badge {
                Text("\(badge)").font(.metaStrong).foregroundStyle(Palette.on).padding(.horizontal, 5).frame(
                    minWidth: 18
                )
                .background(Palette.flag, in: .capsule).accessibilityHidden(true)
            }
        }
    }
}
