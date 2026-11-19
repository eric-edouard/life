import Observation
import SwiftUI

/// Where the app is: the tab, the stack of each tab, and the sheet over them. One place, so a card's matter chip, a push and
/// a tapped ask all go the same way, and a fold keeps the stacks.
@MainActor @Observable
final class AppRouter {
    enum Tab: Hashable { case inbox, matters }
    /// What the Inbox's stack shows above its cards.
    enum InboxRoute: Hashable {
        case toConfirm
        case ask(String)
    }
    enum Sheet: String, Identifiable {
        case pendant, settings
        var id: String { rawValue }
    }

    var tab = Tab.inbox
    /// The matter on show in the Matters tab, by id, and which column a compact width shows: the list or the matter.
    var matter: String?
    var matterColumn = NavigationSplitViewColumn.sidebar
    /// The asks pushed on the matter on show, by check ref: Back returns to the matter, the tab stays on Matters.
    var matterPath: [String] = []
    var inboxPath: [InboxRoute] = []
    var sheet: Sheet?
    /// The matter whose "Start an agent" sheet is open: here, not in the matter's page, so a fold that collapses the page
    /// keeps the sheet and the start it shows.
    var startSheetMatter: String?
    /// "See what they are doing": the Matters list opens filtered to the ones with an agent.
    var showsAgentsOnly = false

    func open(matter id: String) {
        sheet = nil
        tab = .matters
        matterPath = []
        select(matter: id)
    }

    /// The one way the matter on show changes: a compact width then shows it too, so a fold keeps it on screen.
    func select(matter id: String?) {
        if matter != id { matterPath = [] }
        matter = id
        matterColumn = id == nil ? .sidebar : .detail
    }
}
