#if DEBUG
    import Foundation

    /// The design data (`apps/lifelog/fixtures/design/`) put together as the connector's replies: the simulator's fixture
    /// answers with them, and a Kit test reads them with the phone's own models, so a reply that breaks a model fails
    /// there, not on screen.
    public enum DesignReplies {
        /// `read_inbox`: `checks`, with the counts the badge and the tabs read.
        public static func inbox(_ read: [String: Any], checks: [[String: Any]]) -> [String: Any] {
            read.merging([
                "checks": checks,
                "counts": Dictionary(grouping: checks, by: { $0["group"] as? String ?? "" }).mapValues(\.count),
                "total": checks.count, "blocking": checks.count { $0["urgency"] as? String == "blocks" },
            ]) { $1 }
        }

        /// `read_matters`: the rows, without what only a matter's own read holds.
        public static func matters(_ rows: [[String: Any]]) -> [String: Any] {
            ["matters": rows.map { row in row.filter { $0.key != "agents" && $0.key != "steps" } }]
        }

        /// `read_matter`: its row with its agents, its steps (`read_matter.json`'s, by matter; one with none of its own
        /// shows the lease's) and its open checks.
        public static func matter(
            _ row: [String: Any], agents: [[String: Any]], steps: [String: Any], checks: [[String: Any]]
        ) -> [String: Any] {
            let id = row["id"] as? String ?? ""
            let steps = steps as? [String: [[String: Any]]] ?? [:]
            return row.merging([
                "agents": agents.filter { ($0["matter"] as? [String: Any])?["id"] as? String == id },
                "steps": steps[id] ?? steps["matter_lease"] ?? [],
                "checks": checks.filter { ($0["matter"] as? [String: Any])?["id"] as? String == id },
            ]) { $1 }
        }
    }
#endif
