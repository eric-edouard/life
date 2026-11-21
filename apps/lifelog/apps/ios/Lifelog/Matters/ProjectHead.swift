import LifeConnector
import SwiftUI

/// A project chip's header (`read_project`, the project head pattern of decision 98): where it stands in one sentence,
/// its status and the goal it serves with Details behind the info button, the question waiting for him as the one
/// coral card, then its agents as slim rows. Nothing while Life's header is first read: the matters under it come first;
/// a header that failed says so with its retry, whatever its rows show.
struct ProjectHead: View {
    let id: String
    /// His tap on the question: the screen opens it as a sheet.
    let open: (ProjectHeader.Head.Ask) -> Void

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    var body: some View {
        let shown = (life.projectHead[id] ?? ReadState()).shown()
        // Not paired: the rows under it say so, once.
        if case .notPaired = shown {
            EmptyView()
        } else {
            ReadScreen(
                shown: shown, retry: { await life.refreshProjectHead(id) }, loading: { EmptyView() },
                empty: { EmptyView() }, content: { header($0.project) })
        }
    }

    private func header(_ head: ProjectHeader.Head) -> some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            Group {
                let situation = head.situation.map(\.text).joined(separator: " ")
                if !situation.isEmpty {
                    Text(situation).font(.lead).foregroundStyle(Palette.fg)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: Metrics.Spacing.s) {
                    Text(statusLine(head)).font(.small).foregroundStyle(Palette.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    // A round tinted button (decision 98): the whole circle is the tap.
                    Button {
                        router.openDetails(of: id)
                    } label: {
                        Image(systemName: "info").font(.smallStrong).foregroundStyle(Palette.fg)
                            .frame(width: Metrics.tapTarget, height: Metrics.tapTarget)
                            .background(Color.fillTint, in: .circle).contentShape(.circle)
                    }
                    .buttonStyle(.plain).accessibilityLabel("Details")
                }
            }
            .padding(.horizontal, Metrics.gutter)
            if let ask = head.ask { askCard(ask) }
            agents(head.agents)
        }
        .padding(.bottom, Metrics.Spacing.s)
        .motion(Motion.standard, value: head)
    }

    /// "Underway · for your goal: …", his tap on the status first.
    private func statusLine(_ head: ProjectHeader.Head) -> String {
        let status = life.status(of: id, as: head.status).shownWord
        return head.goal.map { "\(status) · for your goal: \($0.text)" } ?? status
    }

    /// The one coral card: "Needs you · by Thu 18:00", the question, its matter.
    private func askCard(_ ask: ProjectHeader.Head.Ask) -> some View {
        Button {
            open(ask)
        } label: {
            HStack(spacing: Metrics.Spacing.m) {
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                    HStack(spacing: Metrics.Spacing.s) {
                        StateDot(color: Palette.flag)
                        Text(
                            ["Needs you", ask.deadline.map { "by " + DeadlineWords.when($0) }].compactMap(\.self)
                                .joined(separator: " · "))
                    }
                    .font(.small).foregroundStyle(Palette.flag)
                    Text(ask.question).font(.sheetQuestion).foregroundStyle(Palette.fg)
                        .fixedSize(horizontal: false, vertical: true)
                    if let matter = ask.matter {
                        Text(matter.name).font(.small).foregroundStyle(Palette.muted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.smallStrong).foregroundStyle(Palette.muted)
            }
            .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.m)
        }
        .buttonStyle(.groupedRow(at: 0, of: 1))
        .accessibilityElement(children: .combine)
    }

    /// Its agents, each by its program's mark (from the desk's read), its title and its live line.
    private func agents(_ agents: [ProjectHeader.Head.Agent]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(agents.enumerated()), id: \.element.id) { at, agent in
                let runtime = life.agents.value?.agents.first { $0.id == agent.id }?.runtimeName ?? .unknown
                Row(title: agent.title, icon: runtime.mark, iconTint: Palette.fg, detail: agent.line, isInList: true) {
                    if agent.status == "running" { Spinner(size: .small).foregroundStyle(Palette.ai) }
                }
                .groupedRow(at: at, of: agents.count)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// A project's question as a sheet (`DuoFoldProjectsAsk`): the card from its matter's read once that read is in (a
/// read older than the sheet could miss it and say it was answered), with Close; his answer closes it.
struct ProjectAsk: View {
    let ask: OpenAsk
    @Binding var notes: CardNotes
    let close: () -> Void

    @Environment(LifeStore.self) private var life
    @State private var opened = Date.now

    var body: some View {
        NavigationStack {
            Group {
                if let matter = ask.ask.matter?.id {
                    ReadScreen(
                        shown: (life.matter[matter] ?? ReadState()).shown(),
                        retry: { await life.refreshMatter(matter) },
                        loading: { PagePlaceholder() }, empty: { EmptyView() }
                    ) { _ in
                        let source = life.asks(ofMatter: matter)
                        if isKnown(in: source) || (life.matter[matter]?.loadedAt).map({ !($0 < opened) }) == true {
                            card(source)
                        } else {
                            PagePlaceholder()
                        }
                    }
                    .task { await life.refreshMatter(matter) }
                } else {
                    card(life.inboxOnShow?.checks ?? [])
                }
            }
            .background(Palette.bg)
            .toolbar { CloseItem(close: close) }
        }
    }

    private func isKnown(in source: [Check]) -> Bool {
        notes.shownCheck?.ref == ask.id || source.contains { $0.ref == ask.id }
    }

    private func card(_ source: [Check]) -> some View {
        CardPage(ref: ask.id, source: source, notes: $notes, leave: close)
    }
}
