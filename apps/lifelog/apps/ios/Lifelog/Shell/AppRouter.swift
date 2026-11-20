import Observation
import SwiftUI

/// Where the app is: the tab, the asks pushed on a matter, and the sheet over them. One place, so a card's matter chip, a push and
/// a tapped ask all go the same way, and a fold keeps them.
@MainActor @Observable
final class AppRouter {
    enum Tab: Hashable { case inbox, matters, people, search }
    enum Sheet: String, Identifiable {
        case pendant, settings
        var id: String { rawValue }
    }

    enum MatterSheet: Identifiable, Equatable {
        /// What wakes the matter's agent.
        case agent(String)
        /// "Start an agent" on the matter.
        case start(String)
        /// The grid that changes the matter's icon.
        case icon(String)

        var id: String {
            switch self {
            case .agent(let id): "agent-\(id)"
            case .start(let id): "start-\(id)"
            case .icon(let id): "icon-\(id)"
            }
        }
    }

    /// What is pushed on the matter on show: one of its asks, by check ref, or the page of its project, by id.
    enum MatterRoute: Hashable {
        case card(String)
        case project(String)
    }

    var tab = Tab.inbox
    /// The matter on show in the Matters tab, by id, and which column a compact width shows: the list or the matter.
    var matter: String?
    var matterColumn = NavigationSplitViewColumn.sidebar
    /// What is pushed on the matter on show (`MatterRoute`): Back returns to the matter, the tab stays on Matters.
    var matterPath: [MatterRoute] = []
    /// Which column of the Inbox a compact width shows: the ask (the default) or the list of asks.
    var inboxColumn = NavigationSplitViewColumn.detail
    var sheet: Sheet?
    /// The person or organization on show in the People tab, by ref, and which column a compact width shows.
    var person: String?
    var personColumn = NavigationSplitViewColumn.sidebar
    /// The sheet open over a matter, by its id: here, not in the matter's page, so a fold that collapses the page keeps the
    /// sheet and the start it shows. One value, so one sheet replaces the other (Try again) in a single update.
    var matterSheet: MatterSheet?

    func open(matter id: String) {
        sheet = nil
        tab = .matters
        matterPath = []
        select(matter: id)
    }

    /// A person's or an organization's page, from wherever one is named: the People tab, on them.
    func open(party ref: String) {
        sheet = nil
        matterSheet = nil
        tab = .people
        select(person: ref)
    }

    /// The one way the person on show changes: a compact width then shows them too, so a fold keeps them on screen.
    func select(person ref: String?) {
        person = ref
        personColumn = ref == nil ? .sidebar : .detail
    }

    /// The one way the matter on show changes: a compact width then shows it too, so a fold keeps it on screen.
    func select(matter id: String?) {
        if matter != id { matterPath = [] }
        matter = id
        matterColumn = id == nil ? .sidebar : .detail
    }
}
