import Foundation
import LifeConnector

/// His actions on the desk's agents: start, stop, resume, and his moves (decision 78), each read back after.
extension LifeStore {
    /// Starts an agent on a matter with the goal he saw, which Life saves as his: `goal_saved`, then the desk's stages.
    func startAgent(on id: String, goal: String, runtime: String? = nil, model: String? = nil) async {
        if await refusedOutOfReach(.start(matter: id)) { return }
        await perform(.start(matter: id)) { [runner] in
            await runner.startAgent(matter: id, goal: goal, runtime: runtime, model: model, emit: $0)
        }
        async let a: Void = refreshMatter(id)
        async let b: Void = refreshAgents()
        async let c: Void = refreshListsOf(id)
        _ = await (a, b, c)
    }

    func stopAgent(_ agent: String) async {
        await change(agent, AgentRequest(action: .stop, agent: agent, said: "Stop it."))
    }
    func resumeAgent(_ agent: String) async {
        await change(agent, AgentRequest(action: .resume, agent: agent, said: "Resume it."))
    }
    private func change(_ agent: String, _ request: AgentRequest) async {
        if await refusedOutOfReach(.agent(agent)) { return }
        await perform(.agent(agent)) { [runner] in await runner.changeAgent(request, emit: $0) }
        await refreshPages(showing: agent)
    }

    /// The agents read again, and the matter pages that draw `agent` from their own read, with their lists and
    /// project headers' spinners.
    private func refreshPages(showing agent: String) async {
        let pages = matter.filter { $0.value.value?.agents.contains { $0.id == agent } == true }.keys
        async let agents: Void = refreshAgents()
        for id in pages {
            async let page: Void = refreshMatter(id)
            async let lists: Void = refreshListsOf(id)
            _ = await (page, lists)
        }
        await agents
    }

    // MARK: Moves

    /// The move matter `id`'s page shows (`AgentMove.shown`).
    /// What Try again may repeat: `tried` (his last ask here) only when what failed was his call, or a move he asked here.
    func retryable<Choice>(_ tried: Choice?, call: ActionFailure?, shown: AgentMove?) -> Choice? {
        call != nil || shown.map { movesAskedHere.contains($0.id) } ?? true ? tried : nil
    }

    func moveShown(ofMatter id: String) -> AgentMove? {
        AgentMove.shown(
            receipt: moveReceipts[id], read: matter[id]?.value?.move, refused: agents.value?.refused ?? [], now: now())
    }

    /// The runtime switch agent `id`'s sheet shows; only `read_registered_agents` carries it.
    func switchShown(of id: String) -> AgentMove? {
        AgentMove.shown(
            receipt: moveReceipts[id], read: agents.value?.agents.first { $0.id == id }?.switch,
            refused: agents.value?.refused ?? [], now: now())
    }

    /// His move of matter `id` to `choice`, in his words: Life answers with the move's id, his receipt; the reads then
    /// say where it stands.
    func move(matter id: String, to choice: MoveChoice, said: String) async {
        let request =
            switch choice {
            case .runtime(let runtime): AgentRequest(action: .handOver, step: id, runtime: runtime.rawValue, said: said)
            case .back(let agent, _): AgentRequest(action: .handOver, agent: agent, step: id, said: said)
            }
        await handOver(id, request)
        async let a: Void = refreshMatter(id)
        async let b: Void = refreshAgents()
        _ = await (a, b)
    }

    /// His switch of agent `id` to `runtime`, in his words.
    func switchAgent(_ id: String, to runtime: RuntimeName, said: String) async {
        await handOver(id, AgentRequest(action: .handOver, agent: id, runtime: runtime.rawValue, said: said))
        await refreshAgents()
    }

    /// Asks the move; once Life answers, its receipt shows it, so the call's own state is forgotten. An answer lost on
    /// the way may still have reached Life: its receipt, with no id, takes the move the reads show under way.
    private func handOver(_ id: String, _ request: AgentRequest) async {
        if await refusedOutOfReach(.move(id)) { return }
        await perform(.move(id)) { [runner] in await runner.changeAgent(request, emit: $0) }
        switch state(of: .move(id)) {
        case .succeeded(.agent(let result), _):
            moveReceipts[id] = MoveReceipt(id: result.move, at: now())
            if let move = result.move { movesAskedHere.insert(move) }
            forget(.move(id))
        case .failed(let failure, _) where failure.mayHaveHappened:
            moveReceipts[id] = MoveReceipt(id: nil, at: now())
        default: break
        }
    }

    /// Settles his receipts against what was just read (`matterRead`: that matter's read; nil: the agents', which hold
    /// the refusals), each once and before any read after: done says so once (then the inbox and the pages showing it
    /// read again); failed is the read's to hold for its hour, or said here when only a refusal holds it; past its
    /// patience it is the read's, a matter's only by its own fresh read.
    func settleMoves(matterRead: String? = nil) {
        var followUp: [String] = []
        for (id, receipt) in moveReceipts where matterRead == nil || id == matterRead {
            let isMatter = matter[id] != nil
            let read = isMatter ? matter[id]?.value?.move : agents.value?.agents.first { $0.id == id }?.switch
            let shown = isMatter ? moveShown(ofMatter: id) : switchShown(of: id)
            switch receipt.settled(by: shown, read: read) {
            case .kept: break
            case .found(let found):
                moveReceipts[id] = found
                if let move = found.id { movesAskedHere.insert(move) }
                forget(.move(id))
            case .gone: if !isMatter || id == matterRead { moveReceipts[id] = nil }
            case .failed(let say):
                moveReceipts[id] = nil
                if let say { show(SaidBack(words: say, undo: nil, isDone: false)) }
            case .done:
                moveReceipts[id] = nil
                show(SaidBack(words: movedWords(id), undo: nil, isDone: true))
                followUp.append(id)
            }
        }
        guard !followUp.isEmpty else { return }
        // A card's mark follows its new holder; a moved matter's lists, and the pages showing a switched agent, read again.
        Task {
            async let inbox: Void = refreshInbox()
            for id in followUp {
                if matter[id] != nil {
                    async let agents: Void = refreshAgents()
                    await refreshListsOf(id)
                    await agents
                } else {
                    await refreshPages(showing: id)
                }
            }
            await inbox
        }
    }

    private func movedWords(_ id: String) -> String {
        if let read = matter[id]?.value {
            return MoveWords.moved(read.row.name, to: read.holder?.agent.runtimeName ?? .unknown)
        }
        let agent = agents.value?.agents.first { $0.id == id }
        return MoveWords.switched(
            agent?.name ?? agent?.runtimeName.name ?? "agent", to: agent?.runtimeName ?? .unknown)
    }
}
