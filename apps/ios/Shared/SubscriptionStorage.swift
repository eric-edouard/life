import Foundation
import Glance
import WidgetKit

nonisolated enum SubscriptionService: String, Sendable {
    case claude, codex

    var name: String { self == .claude ? "Claude Code" : "ChatGPT (Codex)" }
    var shortName: String { self == .claude ? "CC" : "GPT" }
    var kind: String { "SubscriptionUsage.\(rawValue)" }
    private var key: String { self == .claude ? AppGroup.Key.claudeUsage : AppGroup.Key.codexUsage }

    func cached() -> SubscriptionUsage? {
        AppGroup.defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(SubscriptionUsage.self, from: $0) }
    }

    /// Keeps the newest reading. Reloads the dial only when a window it shows changed: a newer observation time alone
    /// waits for the dial's own timeline (`SubscriptionUsage.refreshInterval`), well inside `staleAfter`.
    func save(_ reading: SubscriptionUsage?) {
        guard let reading else { return }
        let old = cached()
        guard reading.observedAt > old?.observedAt ?? 0 else { return }
        AppGroup.defaults.set(try? JSONEncoder().encode(reading), forKey: key)
        if old?.fiveHour != reading.fiveHour || old?.sevenDay != reading.sevenDay {
            WidgetCenter.shared.reloadTimelines(ofKind: kind)
        }
    }
}
