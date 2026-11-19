import LifeConnector
import SwiftUI

/// The agent's row on a matter: its runtime in `ai`, one glance line (who it listens for and its deadline), a chevron.
/// It opens `AgentSheet`.
struct AgentRow: View {
    let agent: RegisteredAgent
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: Metrics.Spacing.s) {
                VStack(alignment: .leading, spacing: 2) {
                    Label(agent.runtimeName.name, systemImage: "sparkle").font(.bodyStrong).foregroundStyle(Palette.ai)
                    if let glance = agent.glance() {
                        Text(glance).font(.small).foregroundStyle(Palette.muted).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.smallStrong).foregroundStyle(Palette.muted)
            }
            .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.m)
            .frame(maxWidth: .infinity, alignment: .leading).card().contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }
}

/// What wakes an agent, read as one sentence down the page, or the one state word of an agent that does not wait.
struct AgentSheet: View {
    let matter: String

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    private var agent: RegisteredAgent? { life.matter[matter]?.value?.agents.first }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let agent {
                head(agent)
                content(agent)
            }
        }
        .padding(.horizontal, Metrics.gutter).padding(.top, Metrics.Spacing.s).padding(.bottom, Metrics.Spacing.m)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.sheet)
        .sheetStack()
        .motion(Motion.standard, value: agent?.status)
        .presentationDetents([.large])
    }

    private func head(_ agent: RegisteredAgent) -> some View {
        SheetHeader(title: nil) { dismiss() }.frame(minHeight: Metrics.tapTarget)
            .overlay(alignment: .leading) {
                Label(agent.runtimeName.name, systemImage: "sparkle").font(.sheetTitle).foregroundStyle(Palette.ai)
            }
    }

    @ViewBuilder private func content(_ agent: RegisteredAgent) -> some View {
        if let why = agent.notStarted {
            word("Not started.", color: Palette.flag, note: why)
            buttons(agent, primary: ("Try again", { router.agentSheetMatter = nil; router.startSheetMatter = matter }))
        } else {
            switch agent.status {
            case .waiting, .unknown: waiting(agent)
            case .running:
                word("Working.", note: agent.statusSince.map { "Since \(WakeFormat.current.time($0))" })
                buttons(agent, primary: nil)
            case .stopped:
                word("Stopped.", note: agent.statusSince.map { "Since \(WakeFormat.current.full($0))" })
                buttons(agent, primary: ("Resume", { Task { await life.resumeAgent(agent.id) } }))
            case .ended, .handedOver:
                word(agent.status == .ended ? "Finished." : "Handed over.", color: Palette.ok,
                    note: agent.statusSince.map { WakeFormat.current.full($0) })
                if let outcome = agent.outcome { Text(outcome).font(.body15).foregroundStyle(Palette.fg).padding(.top, Metrics.Spacing.l) }
                buttons(agent, primary: nil)
            }
        }
    }

    private func word(_ text: String, color: Color = Palette.fg, note: String?) -> some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            Text(text).font(.statusWord).foregroundStyle(color)
            if let note { Text(note).font(.note).foregroundStyle(Palette.muted) }
        }
        .padding(.top, Metrics.Spacing.xl)
    }

    // MARK: Waiting

    private func waiting(_ agent: RegisteredAgent) -> some View {
        let rows = agent.wakesOn.map { $0.row() }
        let wakers = rows.compactMap { row -> Waker? in if case .waker(let waker) = row { waker } else { nil } }
        let clauses = rows.compactMap { row -> WakeClause? in if case .clause(let clause) = row { clause } else { nil } }
        return VStack(alignment: .leading, spacing: 0) {
            if let wait = agent.wait, !wait.isDefault {
                Text("“\(wait.reason)”").font(.body15).foregroundStyle(Palette.fg).padding(.top, Metrics.Spacing.m)
            } else {
                Text("It set no new wait. It listens as before.").font(.note).foregroundStyle(Palette.muted)
                    .padding(.top, Metrics.Spacing.m)
            }
            if let since = agent.statusSince {
                Text("Since \(WakeFormat.current.full(since))").font(.small).foregroundStyle(Palette.muted)
                    .padding(.top, 2)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if !wakers.isEmpty {
                        group("Wakes on a message or a call from") { ForEach(Array(wakers.enumerated()), id: \.offset) { WakerRow(waker: $1) } }
                    }
                    if !clauses.isEmpty {
                        group(wakers.isEmpty ? "Wakes when" : "or when") {
                            ForEach(Array(clauses.enumerated()), id: \.offset) { ClauseRow(clause: $1, open: open) }
                        }
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize).scrollEdgeEffectStyle(.soft, for: .bottom)
            if let until = agent.wait?.until { group("At the latest") { fallback(until) } }
            buttons(agent, primary: nil)
        }
    }

    private func group<Rows: View>(_ title: String, @ViewBuilder rows: () -> Rows) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).label().foregroundStyle(Palette.muted)
            rows()
        }
        .padding(.top, Metrics.Spacing.xl)
    }

    private func fallback(_ until: Date) -> some View {
        HStack(spacing: Metrics.Spacing.m) {
            WakeSlot(symbol: "clock")
            Text(WakeFormat.current.full(until)).font(.leadBold).foregroundStyle(Palette.fg).lineLimit(1)
            Spacer(minLength: 0)
            Text(until.formatted(.relative(presentation: .numeric, unitsStyle: .wide))).font(.note)
                .foregroundStyle(Palette.muted)
        }
        .frame(minHeight: Metrics.Wake.row)
    }

    /// His answer opens that ask on the matter, behind the sheet.
    private func open(_ check: String) {
        router.agentSheetMatter = nil
        router.matterPath.append(check)
    }

    // MARK: Buttons

    /// Stop while it works or waits, a state's own action first, and its session in Claude Code or Codex.
    private func buttons(_ agent: RegisteredAgent, primary: (String, () -> Void)?) -> some View {
        let state = life.state(of: .agent(agent.id))
        return VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            if case .failed(let failure, _) = state { Text(failure.reason).font(.small).foregroundStyle(Palette.flag) }
            HStack(spacing: Metrics.Spacing.s) {
                if let primary {
                    Button(primary.0, action: primary.1).buttonStyle(.pill(.filled, size: .compact, isBusy: state.isRunning))
                } else if agent.status == .running || agent.status == .waiting {
                    Button("Stop the agent") { Task { await life.stopAgent(agent.id) } }
                        .buttonStyle(.pill(.quiet, size: .compact, isBusy: state.isRunning))
                }
                if let link = agent.link.flatMap(URL.init(string:)) {
                    Button("Open in \(agent.runtimeName.name)") { openURL(link) }.buttonStyle(.pill(.quiet, size: .compact))
                } else if primary != nil {
                    Button("Close") { dismiss() }.buttonStyle(.pill(.quiet, size: .compact))
                }
            }
            .disabled(state.isRunning)
        }
        .padding(.top, Metrics.Spacing.l)
    }
}

// MARK: Rows

/// The round 32 slot that leads a wake row.
private struct WakeSlot: View {
    var text: String?
    var symbol: String?
    var isMuted = false

    var body: some View {
        Group {
            if let symbol { Image(systemName: symbol).font(.smallStrong) } else if let text { Text(text).font(.badge) }
        }
        .foregroundStyle(Palette.fg)
        .frame(width: Metrics.Wake.slot, height: Metrics.Wake.slot).background(Color.fillTint, in: .circle)
        .opacity(isMuted ? 0.45 : 1).accessibilityHidden(true)
    }
}

private struct Networks: View {
    let apps: [String]

    var body: some View {
        HStack(spacing: Metrics.Spacing.xs) { ForEach(apps, id: \.self) { NetworkMark(network: $0) } }
    }
}

/// A person or a chat: initials or the group glyph, its name, the networks at the right ("any app" for a person).
private struct WakerRow: View {
    let waker: Waker

    var body: some View {
        let isBroken = waker.brokenReason != nil
        HStack(spacing: Metrics.Spacing.m) {
            switch waker.who {
            case .person(let name): WakeSlot(text: SaidWords.initials(name), isMuted: isBroken)
            case .chat(_, let isGroup): WakeSlot(symbol: isGroup ? "person.2" : "bubble.left", isMuted: isBroken)
            }
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: Metrics.Spacing.s) {
                    switch waker.who {
                    case .person(let name): Text(name).font(.rowName).lineLimit(1)
                    case .chat(let name, let isGroup):
                        if let name {
                            Text(name).font(.rowName).lineLimit(1)
                            if isGroup { Text("group").font(.small).foregroundStyle(Palette.muted) }
                        } else {
                            Text("A chat with no messages yet").font(.rowName).foregroundStyle(Palette.muted).lineLimit(1)
                        }
                    }
                }
                .foregroundStyle(isBroken ? Palette.muted : Palette.fg)
                if let reason = waker.brokenReason { Text(reason).font(.small).foregroundStyle(Palette.flag).lineLimit(1) }
            }
            Spacer(minLength: 0)
            if !isBroken {
                if waker.apps.isEmpty, case .person = waker.who {
                    Text("any app").font(.small).foregroundStyle(Palette.muted)
                } else {
                    Networks(apps: waker.apps)
                }
            }
        }
        .frame(minHeight: Metrics.Wake.row)
        .accessibilityElement(children: .combine)
    }
}

/// One condition: its glyph, the clause (figures and quoted words in the normal weight), the networks or the source's name
/// at the right, and under it what else decides ("or Thu 18:00 passes").
private struct ClauseRow: View {
    let clause: WakeClause
    let open: (String) -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let row = HStack(spacing: Metrics.Spacing.m) {
            WakeSlot(symbol: symbol)
            VStack(alignment: .leading, spacing: 1) {
                Text(words).foregroundStyle(Palette.fg).lineLimit(2)
                if let aside = clause.aside { Text(aside).font(.small).foregroundStyle(Palette.muted).lineLimit(1) }
            }
            Spacer(minLength: 0)
            if clause.check != nil {
                Image(systemName: "chevron.right").font(.smallStrong).foregroundStyle(Palette.muted)
            } else if !clause.apps.isEmpty {
                Networks(apps: clause.apps)
            } else if let source = clause.source {
                Text(source).font(.small).foregroundStyle(Palette.muted)
            }
        }
        .frame(minHeight: Metrics.Wake.row)
        if let check = clause.check {
            Button { open(check) } label: { row.contentShape(.rect) }.buttonStyle(.plain)
        } else {
            row.accessibilityElement(children: .combine)
        }
    }

    private var words: AttributedString {
        var out = AttributedString()
        for piece in clause.pieces {
            var run = AttributedString(piece.text)
            run.font = (piece.isFigure ? TypeStep.rowFigure : TypeStep.rowName).font(at: typeSize)
            out += run
        }
        return out
    }

    private var symbol: String {
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
}
