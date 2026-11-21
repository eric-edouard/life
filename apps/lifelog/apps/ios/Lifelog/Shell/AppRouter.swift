import LifeConnector
import Observation
import SwiftUI

/// Where the app is: the tab, the chosen project chip, the asks pushed on a matter, and the sheet over them. One place, so a card's matter chip, a push and
/// a tapped ask all go the same way, and a fold keeps them.
@MainActor @Observable
final class AppRouter {
    enum Tab: Hashable { case inbox, projects, people, search }
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

    /// What is pushed on the matter on show: one of its asks, by check ref.
    enum MatterRoute: Hashable {
        case card(String)
    }

    /// What the Projects tab's detail column shows: a matter, or a project's Details (decision 95), by id; one at a time.
    enum Detail: Hashable {
        case matter(String)
        case project(String)
    }

    /// What is pushed on the person on show: a part of what Life holds about them (prose, by its ref, with its
    /// title), how each writes to the other, or their exchanges paging back from `latest`.
    enum PersonRoute: Hashable {
        case part(ref: String, title: String)
        case latest(String)
        /// How each writes to the other, from their `now`, by the person's ref.
        case writing(String)
        /// Another party's page, pushed on this one: someone at the organization on show.
        case party(String)
    }

    var tab = Tab.inbox
    /// The Projects tab's chosen chip, by its identity (`ProjectChips.Chip.identity`); nil is All.
    var chip: String?
    /// The detail column's one page, and which column a compact width shows: the list or that page.
    private(set) var detail: Detail?
    /// The matter on show in the Projects tab, by id.
    var matter: String? {
        if case .matter(let id) = detail { id } else { nil }
    }
    var matterColumn = NavigationSplitViewColumn.sidebar
    /// What is pushed on the matter on show (`MatterRoute`): Back returns to the matter, the tab stays on Projects.
    var matterPath: [MatterRoute] = []
    /// Which column of the Inbox a compact width shows: the ask (the default) or the list of asks.
    var inboxColumn = NavigationSplitViewColumn.detail
    var sheet: Sheet?
    /// The person or organization on show in the People tab, by ref, what is pushed on them, and which column a compact
    /// width shows.
    private var people = PageStack<PersonRoute>()
    var person: String? { people.page }
    var personPath: [PersonRoute] {
        get { people.path }
        set { people.path = newValue }
    }
    var personColumn = NavigationSplitViewColumn.sidebar
    /// Whether he opened the person on show from elsewhere (a matter's chip, an agent's wake row), not from the list's
    /// rows: beside the list they then stay through a segment or a read that leaves them out (`PeopleList.selectionOf`).
    private(set) var isPersonFromElsewhere = false
    /// The sheet open over a matter, by its id: here, not in the matter's page, so a fold that collapses the page keeps the
    /// sheet and the start it shows. One value, so one sheet replaces the other (Try again) in a single update.
    var matterSheet: MatterSheet?

    func open(matter id: String) {
        sheet = nil
        tab = .projects
        matterPath = []
        select(matter: id)
    }

    /// A project, from a matter that names it: the Projects tab's list on its chip (decision 95: the filtered list is
    /// the project).
    func open(project chip: String) {
        sheet = nil
        tab = .projects
        self.chip = chip
        matterColumn = .sidebar
    }

    /// A project's Details, beside the list or pushed over it on a compact width.
    func openDetails(of project: String) {
        matterPath = []
        detail = .project(project)
        matterColumn = .detail
    }

    /// A person's or an organization's page, from wherever one is named: the People tab, on them.
    func open(party ref: String) {
        sheet = nil
        matterSheet = nil
        tab = .people
        select(person: ref)
        isPersonFromElsewhere = true
    }

    /// The one way the person on show changes, from the list unless `open(party:)` says otherwise: their page starts
    /// bare, even when they were on show, and a compact width then shows them too, so a fold keeps them on screen.
    func select(person ref: String?) {
        people.open(ref)
        isPersonFromElsewhere = false
        personColumn = ref == nil ? .sidebar : .detail
    }

    /// The one way the matter on show changes: a compact width then shows it too, so a fold keeps it on screen.
    func select(matter id: String?) {
        if matter != id { matterPath = [] }
        detail = id.map { .matter($0) }
        matterColumn = id == nil ? .sidebar : .detail
    }
}
