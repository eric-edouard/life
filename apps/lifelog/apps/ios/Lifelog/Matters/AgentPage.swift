import LifeConnector
import SwiftUI

/// What an agent holds, read from the running matters (`MatterRow.agent`): how many need him, wait on someone, are in
/// work. One reading for the Agents list's counts and the agent's page's groups.
struct HeldMatters {
    let needsYou: [MatterRow]
    let waiting: [MatterRow]
    let inWork: [MatterRow]

    init(of agent: String, in rows: [MatterRow]) {
        let held = rows.filter { $0.agent == agent && !$0.isParked }
        needsYou = held.filter { $0.needsYou == true }
        waiting = held.filter { $0.needsYou != true && $0.status == .waitingOnSomeone }
        inWork = held.filter { $0.needsYou != true && $0.status != .waitingOnSomeone }
    }

    /// "1 needs you · 3 waiting · 1 in work"; nil when it holds nothing running.
    var words: String? {
        let parts = [
            needsYou.isEmpty ? nil : "\(needsYou.count) \(needsYou.count == 1 ? "needs" : "need") you",
            waiting.isEmpty ? nil : "\(waiting.count) waiting",
            inWork.isEmpty ? nil : "\(inWork.count) in work",
        ]
        .compactMap(\.self)
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// The agents at work (AgentsList): each one's mark in a disc, its name, what it holds in words, the flag dot when one of
/// its matters needs him. A row opens its page.
struct AgentsScreen: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    var body: some View {
        let agents = (life.agents.value?.agents ?? []).filter { !$0.isOver }
        let rows = life.matters.value?.matters ?? []
        List {
            ForEach(Array(agents.enumerated()), id: \.element.id) { at, agent in
                let held = HeldMatters(of: agent.id, in: rows)
                Button {
                    router.open(agent: agent.id)
                } label: {
                    HStack(spacing: 12) {
                        Image(symbol: agent.runtimeName.mark).font(.system(size: 20)).foregroundStyle(Palette.fg)
                            .frame(width: 40, height: 40).background(Circle().fill(Palette.tile))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(agent.name ?? agent.title).font(.rowName).foregroundStyle(Palette.fg)
                            Text(held.words ?? agent.stateWord ?? "").font(.small).foregroundStyle(Palette.muted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if !held.needsYou.isEmpty { StateDot(color: Palette.flag) }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 8)
                    .contentShape(.rect)
                }
                .buttonStyle(.groupedRow(at: at, of: agents.count))
                .readingWidth().quietListRow()
            }
            Text("Life gives each matter to its project’s agent, else to the Personal agent.")
                .font(.small).foregroundStyle(Palette.muted)
                .padding(.horizontal, Metrics.gutter).padding(.top, Metrics.Spacing.l)
                .readingWidth().quietListRow()
        }
        .listStyle(.plain).scrollContentBackground(.hidden)
        .background(Palette.bg)
        .screenTitle("Agents")
        .shellBar("", hasSettings: false)
        .task {
            await life.refreshAgents()
            await life.refreshMatters()
        }
    }
}

/// An agent's page (AgentPage): its mark and name, its project's chip, its matters by what each waits for (Needs you in
/// `flag`), then its settings: the program it runs on, and what wakes it (the agent's sheet).
struct AgentPage: View {
    let id: String

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    var body: some View {
        let agent = life.agents.value?.agents.first { $0.id == id }
        let held = HeldMatters(of: id, in: life.matters.value?.matters ?? [])
        List {
            if let agent {
                head(agent).quietListRow()
                group("Needs you", held.needsYou, color: Palette.flag)
                group("Waiting on someone", held.waiting)
                group("In work", held.inWork)
                ListLabel("Settings").readingWidth().quietListRow()
                VStack(spacing: 0) {
                    AgentRunsOn(agent: agent)
                    Button {
                        router.matterSheet = .agent(agent.matter?.id ?? "", agent: id)
                    } label: {
                        Row(title: "What wakes it") { RowValue() }
                    }
                    .buttonStyle(.plain)
                }
                .background(Palette.card, in: .rect(cornerRadius: Metrics.Radius.card))
                .padding(.horizontal, Metrics.gutter)
                .readingWidth().quietListRow()
                if let line = agent.spendingLine() { SpendingLine(text: line).padding(.horizontal, Metrics.gutter).quietListRow() }
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden)
        .background(Palette.bg)
        .shellBar("", hasSettings: false)
        .task {
            await life.refreshAgents()
            await life.refreshMatters()
        }
    }

    private func head(_ agent: RegisteredAgent) -> some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            AgentLabel(runtime: agent.runtimeName, name: agent.name ?? agent.title).font(.screenName)
                .foregroundStyle(Palette.fg).accessibilityAddTraits(.isHeader)
            if let project = agent.project,
                let chip = life.projects.shown().onScreen?.chips.first(where: { $0.kind == .project && $0.id == project })
            {
                QuietChip(chip.name, symbol: MatterIcons.areaSymbol(chip.area ?? chip.id)) {
                    router.open(project: chip.identity)
                }
            }
        }
        .padding(.horizontal, Metrics.gutter).padding(.top, Metrics.Spacing.s)
        .readingWidth()
    }

    @ViewBuilder private func group(_ label: String, _ rows: [MatterRow], color: Color = Palette.muted) -> some View {
        if !rows.isEmpty {
            ListLabel(label).foregroundStyle(color).readingWidth().quietListRow()
            ForEach(Array(rows.enumerated()), id: \.element.id) { at, row in
                Button {
                    router.matterPath.append(.matter(row.id))
                } label: {
                    MatterRowView(row: row, isMarked: life.isImportant(row.id, as: row.important))
                }
                .buttonStyle(.groupedRow(at: at, of: rows.count))
                .readingWidth().quietListRow()
            }
        }
    }
}

/// The program an agent runs on, as a settings row: a pop-up of both (the current checked) while it can switch, asked
/// once; its name when it can't (the other blocked, or it is not at work). A switch under way shows its step; a failed
/// one, why, with Try again when that may be tried.
struct AgentRunsOn: View {
    /// The agent as `read_registered_agents` has it: only that read carries its switch.
    let agent: RegisteredAgent

    @Environment(LifeStore.self) private var life
    /// The program he picked, asked once before the switch.
    @State private var asking: RuntimeName?
    /// The program he last switched it to here: Try again repeats only that.
    @State private var tried: RuntimeName?

    var body: some View {
        let current = agent.runtimeName
        let move = life.switchShown(of: agent.id)
        let isAtWork = agent.status == .running || agent.status == .waiting
        let other = agent.moveTo.flatMap(RuntimeName.init(rawValue:)).flatMap {
            isAtWork && !isSwitching && $0 != current ? $0 : nil
        }
        let call = life.state(of: .move(agent.id)).failure
        let failed = MoveReceipt.failure(
            call: call, shown: move, tried: life.retryable(tried, call: call, shown: move), offered: other)
        let ask = asking.map { MoveWords.switchAsk(agent.name ?? current.name, to: $0) }
        VStack(alignment: .leading, spacing: 0) {
            Row(title: "Runs on") {
                // Starting, it is on its new program already.
                if let words = move.flatMap({ MoveWords.underWay($0, runtime: current) }) {
                    HStack(spacing: 6) {
                        Spinner(size: .small)
                        Text(words)
                    }
                    .font(.small).foregroundStyle(Palette.muted)
                } else if let other {
                    Picker(
                        "Runs on",
                        selection: Binding {
                            current
                        } set: {
                            if $0 == other { asking = other }
                        }
                    ) {
                        ForEach([current, other], id: \.self) { runtime in
                            Label {
                                Text(runtime.name)
                            } icon: {
                                Image(symbol: runtime.mark)
                            }
                            .tag(runtime)
                        }
                    }
                    .pickerStyle(.menu).tint(Palette.muted).lineLimit(1).fixedSize()
                } else {
                    Text(current.name).font(.note).foregroundStyle(Palette.muted).lineLimit(1)
                }
            }
            if let failed {
                MoveFailureLine(reason: failed.reason, retry: failed.retry.map { to in { go(to) } })
                    .padding(.horizontal, 16).padding(.bottom, Metrics.Spacing.s)
            }
        }
        .motion(Motion.standard, value: move?.phase)
        .alert(
            ask?.title ?? "",
            isPresented: Binding {
                asking != nil
            } set: {
                if !$0 { asking = nil }
            },
            presenting: asking
        ) { runtime in
            Button("Cancel", role: .cancel) {}
            Button("Switch") { go(runtime) }
        } message: { _ in
            Text(ask?.message ?? "")
        }
        // While it switches, the agents are read every 3 s, until the switch rests or the row goes.
        .task(id: isSwitching) {
            guard isSwitching else { return }
            while (try? await Task.sleep(for: .seconds(3))) != nil {
                await life.refreshAgents()
            }
        }
    }

    private var isSwitching: Bool {
        life.state(of: .move(agent.id)).isRunning || life.switchShown(of: agent.id)?.phase.isUnderWay == true
    }

    private func go(_ runtime: RuntimeName) {
        tried = runtime
        Task { await life.switchAgent(agent.id, to: runtime, said: "Switch it to \(runtime.name).") }
    }
}
