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

    private var shown: [ThreadEntry] {
        let from = calendar.date(byAdding: .day, value: -3, to: thread.entries.last?.at ?? .now) ?? .distantPast
        return showsEarlier ? thread.entries : thread.entries.filter { $0.at >= from }
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                    if shown.count < thread.entries.count {
                        Button("Show earlier") { showsEarlier = true }.font(.smallStrong).foregroundStyle(Palette.muted)
                            .frame(maxWidth: .infinity)
                    }
                    ForEach(Array(shown.enumerated()), id: \.element.id) { i, entry in
                        if i == 0 || !calendar.isDate(shown[i - 1].at, inSameDayAs: entry.at) {
                            Text(entry.at.formatted(.dateTime.weekday(.wide).day().month()))
                                .font(.small).foregroundStyle(Palette.muted).frame(maxWidth: .infinity)
                        }
                        EntryView(
                            entry: entry, live: thread.live[entry.id], thread: thread, screen: screen, actions: actions)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, Metrics.Spacing.l)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: thread.entries.count) { proxy.scrollTo("end", anchor: .bottom) }
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
                            Text("\(step.verb) \(step.what)").font(.note).foregroundStyle(Palette.muted)
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
                    Text(mine).font(.note).padding(.horizontal, Metrics.Spacing.s).background(
                        Color.fillTint, in: .capsule)
                }
            } else if entry.phase == .failed {
                Text("I couldn't answer that.").foregroundStyle(Palette.muted)
            } else if entry.phase == .stopped {
                Text("Stopped").font(.note).foregroundStyle(Palette.muted)
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
                    Image(systemName: "clock").font(.small).accessibilityLabel("Goes when you're back")
                }
                Text(entry.words)
                if let emoji = entry.lifeReaction { Text(emoji).font(.note) }
            }
            .padding(.horizontal, 14).padding(.vertical, 10).foregroundStyle(Palette.fg)
            .background(
                Palette.fg.opacity(0.11),
                in: UnevenRoundedRectangle(
                    topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20)
            )
        }
        .buttonStyle(.plain).disabled(entry.phase != .failed)
        .frame(maxWidth: 300, alignment: .trailing).frame(maxWidth: .infinity, alignment: .trailing)
    }
}
