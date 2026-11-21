import Foundation
import LifeConnector

/// His actions on the desk's agents: start, stop, resume, and his moves (decision 78), each read back after.
extension LifeStore {
    /// Starts an agent on a matter with the goal he saw, which Life saves as his: `goal_saved`, then the desk's stages.
    func startAgent(on id: String, goal: String, runtime: String? = nil, model: String? = nil) async {
        await perform(.start(matter: id)) { [runner] in
            await runner.startAgent(matter: id, goal: goal, runtime: runtime, model: model, emit: $0)
        }
        async let a: Void = refreshMatter(id)
        async let b: Void = refreshAgents()
        _ = await (a, b)
    }

    func stopAgent(_ agent: String) async {
        await change(agent, AgentRequest(action: .stop, agent: agent, said: "Stop it."))
    }
    func resumeAgent(_ agent: String) async {
        await change(agent, AgentRequest(action: .resume, agent: agent, said: "Resume it."))
    }
    private func change(_ agent: String, _ request: AgentRequest) async {
        await perform(.agent(agent)) { [runner] in await runner.changeAgent(request, emit: $0) }
        await refreshPages(showing: agent)
    }

    /// The agents read again, and the matter pages that draw `agent` from their own read.
    private func refreshPages(showing agent: String) async {
        let pages = matter.filter { $0.value.value?.agents.contains { $0.id == agent } == true }.keys
        async let agents: Void = refreshAgents()
        for id in pages { await refreshMatter(id) }
        await agents
    }

    // MARK: Moves

    /// The move matter `id`'s page shows (`AgentMove.shown`).
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

    /// Asks the move; once Life answers, its receipt shows it, so the call's own state is forgotten.
    private func handOver(_ id: String, _ request: AgentRequest) async {
        await perform(.move(id)) { [runner] in await runner.changeAgent(request, emit: $0) }
        if case .succeeded(.agent(let result), _) = state(of: .move(id)), let move = result.move {
            moveReceipts[id] = MoveReceipt(id: move, at: now())
            forget(.move(id))
        }
    }

    /// Ends each receipt the reads show ended: done says so once (the matter's or the agent's reads follow); failed is
    /// left to the read, which holds it for its hour, or said here when only a refusal holds it; past its patience it
    /// is the read's.
    func endMoves() async {
        for (id, receipt) in moveReceipts {
            let words: String
            let shown: AgentMove?
            if let read = matter[id]?.value {
                shown = moveShown(ofMatter: id)
                words = MoveWords.moved(read.row.name, to: read.holder?.agent.runtimeName ?? .unknown)
            } else if let agent = agents.value?.agents.first(where: { $0.id == id }) {
                shown = switchShown(of: id)
                words = MoveWords.switched(agent.name ?? agent.runtimeName.name, to: agent.runtimeName)
            } else {
                continue
            }
            guard let shown, shown.id == receipt.id else {
                moveReceipts[id] = nil
                continue
            }
            switch shown.phase {
            case .done:
                moveReceipts[id] = nil
                show(SaidBack(words: words, undo: nil, isDone: true))
                // A card's mark follows its new holder; the pages showing a switched agent read it again.
                async let inbox: Void = refreshInbox()
                await refreshPages(showing: id)
                await inbox
            case .failed:
                moveReceipts[id] = nil
                let isRead = matter[id]?.value?.move?.id == receipt.id || switchReadId(id) == receipt.id
                if !isRead { show(SaidBack(words: shown.reason ?? "It did not move.", undo: nil)) }
            default: break
            }
        }
    }

    private func switchReadId(_ id: String) -> String? { agents.value?.agents.first { $0.id == id }?.switch?.id }
}
