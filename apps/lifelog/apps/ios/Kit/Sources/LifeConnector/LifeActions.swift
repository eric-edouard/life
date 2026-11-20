import Foundation
import Library

/// What an action proves when it succeeds.
public enum ActionProof: Sendable, Equatable {
    case answered(AnswerResult)
    case agent(AgentChangeResult)
    /// A change recorded (a goal, a next step, a matter done, a to-do item).
    case recorded
    /// His "Wrong…": the caretaker received his complaint (its receipt), Life's ask `ask`.
    case complaintReceipt(ask: String)
}

/// What `answer_check` returns for his "Wrong…" (`complain`, `host/complaints.ts`), only once the caretaker has it.
private struct Reached: Decodable {
    let ask: String
    let reached: String
}

/// His actions on Life, as one machine each: they run the calls, turn progress and results into `ActionState` events and
/// decide what may be tried again. No state of its own: the store owns each action's state and applies the events in order.
public struct LifeActions: Sendable {
    public typealias Emit = @Sendable (ActionState<ActionProof>.Event) -> Void

    /// A call dropped or unreachable is repeated (the same tap, the same key) up to this many tries, `pause` apart.
    static let tries = 3

    private let api: any LifeAPI
    private let now: @Sendable () -> Date
    private let pause: @Sendable (Duration) async -> Void

    public init(
        api: any LifeAPI, now: @escaping @Sendable () -> Date = { Date() },
        pause: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }
    ) {
        (self.api, self.now, self.pause) = (api, now, pause)
    }

    private func progress(_ emit: @escaping Emit) -> @Sendable (Data) -> Void {
        { data in
            if let message = ActionProgress(data) { emit(message.event(at: now())) }
        }
    }

    private func decode<V: Decodable>(_ type: V.Type, _ text: String) -> V? {
        try? LibraryStore.feedDecoder.decode(type, from: Data(text.utf8))
    }

    // MARK: Answer

    /// His answer to a check. `key` is made once at his tap and given again to every repeat of it: Life then returns the
    /// first call's result and sends nothing twice. A connection that drops is repeated; a `not sent` is a new tap.
    public func answer(_ request: AnswerRequest, key: String, emit: @escaping Emit) async {
        emit(.started)
        var dropped = ActionFailure(reason: "", retry: .allowed)
        for attempt in 0..<Self.tries {
            if attempt > 0 {
                // The same tap again, with the same key: the screen and the phone's log say it was repeated and why.
                let detail = ["of": "\(Self.tries)", "try": "\(attempt + 1)", "why": dropped.reason]
                emit(.passed("connection_retry", at: now(), detail: detail))
                await pause(.seconds(2))
            }
            do {
                let text = try await api.answerCheck(request, answerKey: key, onProgress: progress(emit))
                // His "Wrong…" has one proof: the caretaker has it. Anything else may be tried again under its key.
                if request.isComplaint {
                    guard let reached = decode(Reached.self, text), reached.reached == "caretaker" else {
                        return emit(.failed(Self.unreadable))
                    }
                    return emit(.succeeded(.complaintReceipt(ask: reached.ask)))
                }
                guard let result = decode(AnswerResult.self, text) else {
                    return emit(.failed(Self.unreadable))
                }
                // A new matter's Start that did not start is a start's failure, never a success.
                if let start = result.start, start.state != .started {
                    return emit(await ending(of: start, matter: request.ref))
                }
                return emit(Self.ending(of: result))
            } catch MCPError.unreachable {
                dropped = ActionFailure(.unreachable)
            } catch MCPError.streamDropped {
                dropped = ActionFailure(.streamDropped)
            } catch {
                return emit(.failed(ActionFailure(MCPError.of(error))))
            }
        }
        emit(.failed(dropped))
    }

    private static let unreadable = ActionFailure(
        reason: "Life answered, but not in a way this app reads. Check the card before answering again.",
        retry: .no, mayHaveHappened: true)

    static func ending(of result: AnswerResult) -> ActionState<ActionProof>.Event {
        guard let send = result.send else { return .succeeded(.answered(result)) }
        switch send.state {
        case .notSent:
            var failure = ActionFailure(
                reason: send.reason ?? "It was not sent.", retry: send.canRetry == true ? .allowed : .no)
            failure.wrote = send.wrote
            return .failed(failure)
        case .mayHaveGone:
            return .failed(ActionFailure(reason: send.reason ?? "It may have gone.", retry: .no, mayHaveHappened: true))
        case .pending:
            return .failed(
                ActionFailure(
                    reason: "The send had not ended when Life answered. Check the chat before sending again.",
                    retry: .no, mayHaveHappened: true))
        case .sent: return .succeeded(.answered(result))
        case .unknown:
            return .failed(
                ActionFailure(
                    reason: "Life answered in a way this app does not read. It may have gone.",
                    retry: .no, mayHaveHappened: true))
        }
    }

    // MARK: Agents

    /// An agent started on a matter with `goal`, the goal he saw, as its brief: Life saves it as his goal itself
    /// (`goal_saved`), then reports the desk's stages. When Life does not confirm, the matter is read: an agent on it
    /// that has not ended is the proof, none is a start that may have happened.
    public func startAgent(matter: String, goal: String, runtime: String?, model: String?, emit: @escaping Emit) async {
        emit(.started)
        let request = AgentRequest(action: .start, step: matter, runtime: runtime, model: model, said: goal)
        do {
            let text = try await api.changeAgent(request, onProgress: progress(emit))
            guard let result = decode(AgentChangeResult.self, text) else { return emit(.failed(Self.unreadable)) }
            return emit(await ending(of: result, matter: matter))
        } catch MCPError.refused(let why) {
            return emit(.failed(ActionFailure(reason: why, retry: .no)))
        } catch {}
        emit(await resolved(matter: matter, agent: nil))
    }

    /// How a start ended, as the desk said: started, not started (at its stage), else read from its matter.
    private func ending(of start: AgentChangeResult, matter: String) async -> ActionState<ActionProof>.Event {
        switch start.state {
        case .started: return .succeeded(.agent(start))
        case .notStarted:
            let why = start.failed
            return .failed(
                ActionFailure(
                    step: why?.stage, reason: why?.reason ?? "The agent did not start.",
                    // An agent already holds the matter: starting again would only be refused again.
                    retry: start.nothingRunning == false ? .no : .allowed))
        default: return await resolved(matter: matter, agent: start.agent)
        }
    }

    /// A start Life did not confirm, read from its matter: the agent the desk named, else any on it, that has not ended.
    private func resolved(matter id: String, agent named: String?) async -> ActionState<ActionProof>.Event {
        if let text = try? await api.readMatter(id), let matter = decode(Matter.self, text),
            let agent = matter.agents.first(where: { !$0.isOver && (named == nil || $0.id == named) })
        {
            return .succeeded(.agent(AgentChangeResult(action: "start", state: .started, agent: agent.id)))
        }
        return .failed(
            ActionFailure(
                reason: "Life did not confirm that the agent started, and none shows on this matter.", retry: .no,
                mayHaveHappened: true))
    }

    /// Stop, resume or change the model of an agent.
    public func changeAgent(_ request: AgentRequest, emit: @escaping Emit) async {
        emit(.started)
        do {
            let text = try await api.changeAgent(request, onProgress: progress(emit))
            guard let result = decode(AgentChangeResult.self, text) else { return emit(.failed(Self.unreadable)) }
            emit(
                result.state == .done
                    ? .succeeded(.agent(result))
                    : .failed(
                        ActionFailure(
                            reason: "The desk did not confirm it in time.", retry: .allowed, mayHaveHappened: true)))
        } catch {
            emit(.failed(ActionFailure(MCPError.of(error))))
        }
    }

    // MARK: His edits

    /// One recorded change (his goal, next step, a matter done, a to-do item): no plan of the phone's, only the 10
    /// seconds Life is first assumed to need; Life's plan and limit come first in its first message, and `recorded`
    /// is added when an older server sends no plan.
    public func record(
        emit: @escaping Emit, _ change: @Sendable (@escaping @Sendable (Data) -> Void) async throws -> String
    ) async {
        emit(.started)
        emit(.planned([], limitSeconds: 10, at: now()))
        do {
            _ = try await change(progress(emit))
            emit(.passed("recorded", at: now(), detail: [:]))
            emit(.succeeded(.recorded))
        } catch {
            emit(.failed(ActionFailure(MCPError.of(error), step: "recorded")))
        }
    }
}
