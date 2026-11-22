/// What an agent holds, read from the running matters (`MatterRow.agent`): how many need him, wait on someone, are in
/// work. One reading for the Agents list's counts and the agent's page's groups.
public struct HeldMatters {
    public let needsYou: [MatterRow]
    public let waiting: [MatterRow]
    public let inWork: [MatterRow]

    public init(of agent: String, in rows: [MatterRow]) {
        let held = rows.filter { $0.agent == agent && !$0.isParked }
        needsYou = held.filter { $0.needsYou == true }
        waiting = held.filter { $0.needsYou != true && $0.status == .waitingOnSomeone }
        inWork = held.filter { $0.needsYou != true && $0.status != .waitingOnSomeone }
    }

    /// "1 needs you · 3 waiting · 1 in work"; nil when it holds nothing running.
    public var words: String? {
        let parts = [
            needsYou.isEmpty ? nil : "\(needsYou.count) \(needsYou.count == 1 ? "needs" : "need") you",
            waiting.isEmpty ? nil : "\(waiting.count) waiting",
            inWork.isEmpty ? nil : "\(inWork.count) in work",
        ]
        .compactMap(\.self)
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
