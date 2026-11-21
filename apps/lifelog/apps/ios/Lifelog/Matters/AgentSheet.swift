import LifeConnector
import SwiftUI

/// What wakes an agent, read as one sentence down the page, or the one state word of an agent that does not wait; what its
/// session spent last.
struct AgentSheet: View {
    let matter: String
    /// The agent shown; nil: the matter's first.
    var agentID: String?

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    /// The program he picked, asked once before the switch.
    @State private var asking: RuntimeName?
    /// The program he last switched it to here: Try again repeats only that.
    @State private var tried: RuntimeName?

    /// The agent named, in the matter's read or else in `read_registered_agents`; none named, the matter's first. Its
    /// names and its switch are only in `read_registered_agents` (`registered`).
    private var agent: RegisteredAgent? {
        let ones = life.matter[matter]?.value?.agents
        guard let agentID else { return ones?.first }
        return ones?.first { $0.id == agentID } ?? registered(agentID)
    }

    /// The agent as `read_registered_agents` has it: only that read carries its spending.
    private func registered(_ id: String) -> RegisteredAgent? { life.agents.value?.agents.first { $0.id == id } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let agent {
                runsOn(agent)
                content(agent)
                // A refused Stop or Resume says why in the scroll, which holds any length; the bar keeps the buttons.
                if case .failed(let failure, _) = life.state(of: .agent(agent.id)) {
                    Text(failure.reason).font(.small).foregroundStyle(Palette.flag).padding(.top, Metrics.Spacing.l)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let line = registered(agent.id)?.spendingLine() { SpendingLine(text: line) }
            }
        }
        .sheetScroll {
            if let agent { head(agent) }
        } buttons: {
            if let agent { buttons(agent) }
        }
        .background(Palette.sheet)
        .saysBack()
        .sheetStack()
        .motion(Motion.standard, value: agent?.status)
        .presentationDetents([.large])
        .alert(
            switchAsk?.title ?? "",
            isPresented: Binding {
                asking != nil
            } set: {
                if !$0 { asking = nil }
            },
            presenting: asking
        ) { runtime in
            Button("Cancel", role: .cancel) {}
            Button("Switch") { if let agent { go(agent, to: runtime) } }
        } message: { _ in
            Text(switchAsk?.message ?? "")
        }
        // While it switches, the sheet reads the agents every 3 s, until the switch rests or the sheet goes.
        .task(id: isSwitching) {
            guard isSwitching else { return }
            while (try? await Task.sleep(for: .seconds(3))) != nil {
                await life.refreshAgents()
            }
        }
    }

    private var switchAsk: (title: String, message: String)? {
        guard let asking, let agent else { return nil }
        return MoveWords.switchAsk(nameOf(agent), to: asking)
    }

    private var isSwitching: Bool {
        guard let agent else { return false }
        return life.state(of: .move(agent.id)).isRunning || life.switchShown(of: agent.id)?.phase.isUnderWay == true
    }

    /// Its name ("Halden house agent"), else its program's.
    private func nameOf(_ agent: RegisteredAgent) -> String {
        registered(agent.id)?.name ?? agent.runtimeName.name
    }

    private func go(_ agent: RegisteredAgent, to runtime: RuntimeName) {
        tried = runtime
        Task { await life.switchAgent(agent.id, to: runtime, said: "Switch it to \(runtime.name).") }
    }

    // MARK: Runs on

    /// The program it runs on: a pop-up of both (the current checked) while it can switch, asked once; plain text when
    /// it can't (the other blocked, or it is not at work). A switch under way shows its step; a failed one, why, with
    /// Try again when that may be tried.
    private func runsOn(_ agent: RegisteredAgent) -> some View {
        // The current program and the other one, from the one read that has both.
        let read = registered(agent.id) ?? agent
        let current = read.runtimeName
        let move = life.switchShown(of: agent.id)
        let isAtWork = read.status == .running || read.status == .waiting
        let other = read.moveTo.flatMap(RuntimeName.init(rawValue:)).flatMap {
            isAtWork && !isSwitching && $0 != current ? $0 : nil
        }
        let failed = MoveReceipt.failure(
            call: life.state(of: .move(agent.id)).failure, shown: move, tried: tried, offered: other)
        return group("Settings") {
            FlatRow(lead: .symbol("cpu")) {
                Text("Runs on").font(.rowName)
            } trailing: {
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
                    .pickerStyle(.menu).tint(Palette.muted)
                } else {
                    Text(current.name).font(.small).foregroundStyle(Palette.muted)
                }
            }
            if let failed {
                MoveFailureLine(reason: failed.reason, retry: failed.retry.map { to in { go(agent, to: to) } })
            }
        }
        .padding(.top, Metrics.Spacing.xl)
        .motion(Motion.standard, value: move?.phase)
    }

    private func head(_ agent: RegisteredAgent) -> some View {
        SheetHeader(title: nil) { dismiss() }.frame(minHeight: Metrics.tapTarget)
            .overlay(alignment: .leading) {
                AgentLabel(runtime: (registered(agent.id) ?? agent).runtimeName, name: registered(agent.id)?.name)
                    .font(.sheetQuestion)
            }
    }

    @ViewBuilder private func content(_ agent: RegisteredAgent) -> some View {
        if let why = agent.notStarted {
            word(agent, color: Palette.flag, note: why)
        } else {
            switch agent.status {
            case .waiting, .unknown: waiting(agent)
            case .running: word(agent, note: agent.statusSince.map { "Since \(SaidWords.time($0))" })
            case .stopped: word(agent, note: agent.statusSince.map { "Since \(SaidWords.moment($0))" })
            case .ended, .handedOver:
                word(agent, color: Palette.ok, note: agent.statusSince.map { SaidWords.moment($0) })
                if let outcome = agent.outcome {
                    Text(outcome).font(.body15).foregroundStyle(Palette.fg).padding(.top, Metrics.Spacing.l)
                }
            }
        }
    }

    private func word(_ agent: RegisteredAgent, color: Color = Palette.fg, note: String?) -> some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            HStack(spacing: Metrics.Spacing.s) {
                Text("\(agent.stateWord ?? "").").font(.statusWord).foregroundStyle(color)
                if agent.status == .running { StateGlyph.busy }
            }
            if let note { Text(note).font(.note).foregroundStyle(Palette.muted) }
        }
        .padding(.top, Metrics.Spacing.xl)
    }

    // MARK: Waiting

    private func waiting(_ agent: RegisteredAgent) -> some View {
        let rows = agent.wakesOn.map { $0.row() }
        let wakers = rows.compactMap { row -> Waker? in if case .waker(let waker) = row { waker } else { nil } }
        let clauses = rows.compactMap { row -> WakeClause? in if case .clause(let clause) = row { clause } else { nil }
        }
        return VStack(alignment: .leading, spacing: 0) {
            if let wait = agent.wait, !wait.isDefault {
                Text("“\(wait.reason)”").font(.body15).foregroundStyle(Palette.fg).padding(.top, Metrics.Spacing.m)
            } else {
                Text("It set no new wait. It listens as before.").font(.note).foregroundStyle(Palette.muted)
                    .padding(.top, Metrics.Spacing.m)
            }
            if let since = agent.statusSince {
                Text("Since \(SaidWords.moment(since))").font(.small).foregroundStyle(Palette.muted)
                    .padding(.top, Metrics.Spacing.xs)
            }
            VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                if !wakers.isEmpty {
                    group("Wakes on a message or a call from") {
                        ForEach(Array(wakers.enumerated()), id: \.offset) { wakerButton($1) }
                    }
                }
                if !clauses.isEmpty {
                    group(wakers.isEmpty ? "Wakes when" : "or when") {
                        ForEach(Array(clauses.enumerated()), id: \.offset) { clauseRow($1) }
                    }
                }
                if let until = agent.wait?.until {
                    group("At the latest") {
                        FlatRow(lead: .symbol("clock")) {
                            Text(SaidWords.moment(until)).font(.leadBold)
                        } trailing: {
                            Text(until.formatted(.relative(presentation: .numeric, unitsStyle: .wide)))
                                .font(.note).foregroundStyle(Palette.muted)
                        }
                    }
                }
            }
            .padding(.top, Metrics.Spacing.xl)
        }
    }

    /// A label above its flat rows; the label stays with them in the one scroll.
    private func group<Rows: View>(_ title: String, @ViewBuilder rows: () -> Rows) -> some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            Text(title).label().foregroundStyle(Palette.muted).accessibilityAddTraits(.isHeader)
            rows()
        }
    }

    /// A person he knows opens their page (the sheet closes, the People tab shows them); a chat, or someone who no
    /// longer resolves, is only a row.
    @ViewBuilder private func wakerButton(_ waker: Waker) -> some View {
        if case .person(_, let party?) = waker.who {
            Button {
                router.open(party: party.ref)
            } label: {
                wakerRow(waker).contentShape(.rect)
            }
            .buttonStyle(.plain)
        } else {
            wakerRow(waker)
        }
    }

    /// A person or a chat: their disc or the group glyph, its name, the networks at the right ("any app" for a person).
    private func wakerRow(_ waker: Waker) -> some View {
        let isBroken = waker.brokenReason != nil
        return FlatRow(
            lead: lead(of: waker), detail: waker.brokenReason, detailColor: Palette.flag, isMuted: isBroken
        ) {
            switch waker.who {
            case .person(let name, _): Text(name).font(.rowName)
            case .chat(let name?, let isGroup):
                HStack(alignment: .firstTextBaseline, spacing: Metrics.Spacing.s) {
                    Text(name).font(.rowName)
                    if isGroup { Text("group").font(.small).foregroundStyle(Palette.muted) }
                }
            case .chat(nil, _): Text("A chat with no messages yet").font(.rowName).foregroundStyle(Palette.muted)
            }
        } trailing: {
            if waker.apps.isEmpty, case .person = waker.who {
                Text("any app").font(.small).foregroundStyle(Palette.muted)
            } else {
                Networks(apps: waker.apps)
            }
        }
    }

    private func lead(of waker: Waker) -> FlatLead {
        switch waker.who {
        case .person(let name, let party): .person(name: name, party: party)
        case .chat(_, let isGroup): .symbol(isGroup ? "person.2" : "bubble.left")
        }
    }

    /// One condition; his answer opens that ask on the matter, behind the sheet.
    @ViewBuilder private func clauseRow(_ clause: WakeClause) -> some View {
        let row = FlatRow(
            lead: .symbol(symbol(of: clause)), detail: clause.brokenReason ?? clause.aside,
            detailColor: clause.brokenReason == nil ? Palette.muted : Palette.flag, isMuted: clause.brokenReason != nil
        ) {
            ClauseText(pieces: clause.pieces)
        } trailing: {
            if clause.check != nil {
                Image(systemName: "chevron.right").font(.smallStrong).foregroundStyle(Palette.muted)
            } else if !clause.apps.isEmpty {
                Networks(apps: clause.apps)
            } else if let source = clause.source {
                Text(source).font(.small).foregroundStyle(Palette.muted)
            }
        }
        if let check = clause.check {
            Button {
                router.matterSheet = nil
                router.matterPath.append(.card(check))
            } label: {
                row.contentShape(.rect)
            }.buttonStyle(.plain)
        } else {
            row
        }
    }

    private func symbol(of clause: WakeClause) -> String {
        switch clause.glyph {
        case .person: "person"
        case .bubble: "bubble.left"
        case .mail: "envelope"
        case .payments: "creditcard"
        case .answer: "arrowshape.turn.up.left"
        case .nearby: "dot.radiowaves.left.and.right"
        case .ring: "circle"
        }
    }

    // MARK: Buttons

    /// Stop while it works or waits, a state's own action first; under them, a quiet link to its session in Claude Code or
    /// Codex, never needed (his word of 20 Nov: anything waiting on him comes back to the app).
    private func buttons(_ agent: RegisteredAgent) -> some View {
        let state = life.state(of: .agent(agent.id))
        let primary: (String, () -> Void)? =
            if agent.notStarted != nil {
                ("Try again", { router.matterSheet = .start(matter) })
            } else if agent.status == .stopped {
                ("Resume", { Task { await life.resumeAgent(agent.id) } })
            } else {
                nil
            }
        return VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            // One full-width button (the sheet closes from its own Close), then the session's quiet link.
            Group {
                if let primary {
                    Button(primary.0, action: primary.1).buttonStyle(
                        .pill(.filled, size: .compact, isBusy: state.isRunning))
                } else if agent.status == .running || agent.status == .waiting {
                    Button("Stop the agent") { Task { await life.stopAgent(agent.id) } }
                        .buttonStyle(.pill(.quiet, size: .compact, isBusy: state.isRunning))
                }
            }
            .disabled(state.isRunning)
            if let link = agent.link.flatMap(URL.init(string:)) {
                TextLink("Open in \(agent.runtimeName.name)", to: .outside) { openURL(link) }
                    .padding(.top, Metrics.Spacing.xs).frame(maxWidth: .infinity)
            }
        }
    }
}
