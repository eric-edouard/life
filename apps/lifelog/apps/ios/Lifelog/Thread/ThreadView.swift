import LifeConnector
import SwiftUI

/// The one endless conversation: opens at its bottom, day separators, Show earlier for what is older than three days.
struct ThreadView: View {
    let thread: LifeThread
    let screen: MainSessionScreen
    let actions: BlockActions
    var isPaired = true
    @State private var showsEarlier = false
    @Environment(\.calendar) private var calendar
    @Environment(LifeStore.self) private var life

    private var shown: [ThreadEntry] {
        let from = calendar.date(byAdding: .day, value: -3, to: thread.entries.last?.at ?? .now) ?? .distantPast
        return showsEarlier ? thread.entries : thread.entries.filter { $0.at >= from }
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                    if shown.count < thread.entries.count {
                        Button("Show earlier") { showsEarlier = true }.font(.heading).foregroundStyle(Palette.muted)
                            .frame(maxWidth: .infinity)
                    }
                    ForEach(Array(shown.enumerated()), id: \.element.id) { i, entry in
                        if i == 0 || !calendar.isDate(shown[i - 1].at, inSameDayAs: entry.at) {
                            Text(entry.at.formatted(.dateTime.weekday(.wide).day().month()))
                                .font(.line).foregroundStyle(Palette.muted).frame(maxWidth: .infinity)
                        }
                        EntryView(
                            entry: entry, live: thread.live[entry.id], thread: thread, screen: screen, actions: actions)
                    }
                    // An ask he was sent to (a notification, a link) that is no row above: Life brings it to the bottom,
                    // unfolded with its answers.
                    if let ask = life.focused.flatMap(life.ask) { ItemRow(ask: ask).id(ask.ref) }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, Metrics.Spacing.l)
            }
            .defaultScrollAnchor(.bottom)
            // The keyboard shrinks the thread from below: its bottom stays where it was.
            .defaultScrollAnchor(.bottom, for: .sizeChanges)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: thread.entries.count) { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: life.focused) { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: thread.live) { proxy.scrollTo("end", anchor: .bottom) }
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

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            bubble
            if let live {
                VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
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
            .padding(.horizontal, 14).padding(.vertical, 10).foregroundStyle(Palette.fg)
            .background(
                Palette.tint,
                in: UnevenRoundedRectangle(
                    topLeadingRadius: Metrics.Radius.block, bottomLeadingRadius: Metrics.Radius.block,
                    bottomTrailingRadius: Metrics.Radius.control / 2, topTrailingRadius: Metrics.Radius.block)
            )
        }
        .buttonStyle(.plain).disabled(entry.phase != .failed)
        .frame(maxWidth: 300, alignment: .trailing).frame(maxWidth: .infinity, alignment: .trailing)
    }
}
