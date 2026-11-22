import Foundation
import LifeConnector

/// One `life.action` event per action that ended: what it was, how it ended, how long it took against its limit, and
/// each step with the seconds it passed after the start. Ids, states and counts only; the kind of a lost connection, never its words.
func traceAction(
    _ key: LifeStore.ActionKey, tap: String?, _ ended: ActionState<ActionProof>, began: Date, finished: Date,
    limit: Date?
) {
    var fields = [
        "seconds": String(format: "%.1f", finished.timeIntervalSince(began)),
        "steps": ended.steps.map { step in
            "\(step.id)@" + (step.passedAt.map { String(format: "%.1f", $0.timeIntervalSince(began)) } ?? "-")
        }.joined(separator: ","),
    ]
    switch key {
    case .answer(let ref): fields["kind"] = "answer"; fields["ref"] = ref
    case .start(let matter): fields["kind"] = "start"; fields["ref"] = matter
    case .agent(let agent): fields["kind"] = "agent"; fields["ref"] = agent
    case .move(let id): fields["kind"] = "move"; fields["ref"] = id
    case .edit(let matter, let what): fields["kind"] = "edit.\(what)"; fields["ref"] = matter
    case .project(let id): fields["kind"] = "project"; fields["ref"] = id
    case .appointment(let id): fields["kind"] = "appointment"; fields["ref"] = id
    case .picture(let ref): fields["kind"] = "picture"; fields["ref"] = ref
    }
    if let tap { fields["key"] = String(tap.prefix(8)) }
    if let limit {
        fields["limit"] = String(format: "%.0f", limit.timeIntervalSince(began))
        fields["late"] = limit < finished ? "yes" : "no"
    }
    switch ended {
    case .succeeded: fields["outcome"] = "succeeded"
    case .failed(let failure, _):
        fields["outcome"] = "failed"
        fields["reason"] = failure.isSameTap ? failure.kind : failure.step ?? "-"
        fields["mayHaveHappened"] = failure.mayHaveHappened ? "yes" : "no"
    default: fields["outcome"] = "unfinished"
    }
    appEvent("life.action", fields)
}
