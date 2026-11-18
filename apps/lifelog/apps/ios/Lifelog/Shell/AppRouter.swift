import Observation
import SwiftUI

/// Where the app is: the tab, the matters stack, and the sheet over them. One place, so a card's matter chip, a push and
/// a tapped "Answer" all go the same way.
@MainActor @Observable
final class AppRouter {
    enum Tab: Hashable { case inbox, matters }
    enum Sheet: String, Identifiable {
        case pendant, settings
        var id: String { rawValue }
    }

    var tab = Tab.inbox
    /// The matters stack: a matter's id per page.
    var matters: [String] = []
    var sheet: Sheet?
    /// A card the Inbox should show next (a matter's "Answer").
    var focusedCard: String?
    /// "See what they are doing": the Matters list opens filtered to the ones with an agent.
    var showsAgentsOnly = false

    func open(matter id: String) {
        sheet = nil
        tab = .matters
        matters = [id]
    }

    func answer(card ref: String) {
        tab = .inbox
        focusedCard = ref
    }
}
