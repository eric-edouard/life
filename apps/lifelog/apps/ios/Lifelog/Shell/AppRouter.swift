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
        /// What wakes an agent of the matter: the one named by id, else the matter's first.
        case agent(String, agent: String? = nil)
        /// "Start an agent" on the matter.
        case start(String)
        /// The grid that changes the matter's icon.
        case icon(String)

        var id: String {
            switch self {
            case .agent(let id, let agent): "agent-\(id)-\(agent ?? "")"
            case .start(let id): "start-\(id)"
            case .icon(let id): "icon-\(id)"
            }
        }
    }

    /// What is pushed on the detail column's page: one of its asks, by check ref; an agent's page; a matter from an
    /// agent's page. Back returns to the page under it.
    enum MatterRoute: Hashable {
        case card(String)
        case agent(String)
        case matter(String)
    }

    /// What the Projects tab's detail column shows: a matter, or a project's Details (decision 95), by id, or the
    /// agents (`AgentsScreen`); one at a time.
    enum Detail: Hashable {
        case matter(String)
        case project(String)
        case agents
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

    var tab = Tab.inbox {
        didSet { if tab != .people { personCameFrom = nil } }
    }
    /// The tab he was on when a person was opened from elsewhere (`open(party:)`): Back from that page returns there.
    private(set) var personCameFrom: Tab?
    /// The Projects tab's chosen chip, by its identity (`ProjectChips.Chip.identity`); nil is All. Choosing one lets
    /// its list choose the matter on show again.
    var chip: String? {
        didSet { isMatterFromElsewhere = false }
    }
    /// The detail column's one page, and which column a compact width shows: the list or that page.
    private(set) var detail: Detail?
    /// The matter on show in the Projects tab, by id.
    var matter: String? {
        if case .matter(let id) = detail { id } else { nil }
    }
    var matterColumn = NavigationSplitViewColumn.sidebar
    /// Whether he opened the matter on show from elsewhere (a card's chip, Search, a person), not from the list's rows:
    /// beside the list it then stays through a chip whose list leaves it out.
    private(set) var isMatterFromElsewhere = false
    /// A project's question, open as a sheet over the Projects tab: here, so opening a matter or a person from it
    /// closes it.
    var projectAsk: OpenAsk?
    /// What is pushed on the matter on show (`MatterRoute`): Back returns to the matter, the tab stays on Projects.
    var matterPath: [MatterRoute] = []
    /// Which column of the Inbox a compact width shows: the ask (the default) or the list of asks.
    var inboxColumn = NavigationSplitViewColumn.detail
    var sheet: Sheet?
    /// Tell Life, full screen over whatever he was on.
    var isTellLifeOpen = false
    /// Where the system put the Pendant (its frame in the window): in the side column of the closed Duo, or at the top
    /// bar's trailing end. Tell Life stands on its vertical line, below it; nil before the Pendant is drawn.
    var pendantFrame: CGRect?
    /// Where the system put the Settings gear, while it shows: Tell Life stands below it too.
    var settingsFrame: CGRect?
    /// Tell Life made small: its strip shows over the rail while there is something to keep in sight.
    var isTellLifeSmall = false
    /// What his words are about when he opens Tell Life from a card ("Wrong…"): the card's ref and its question.
    var tellContext: (ref: String, question: String)?

    /// Tell Life on a card: his words go with that card on screen.
    func tellLife(about ref: String, question: String) {
        tellContext = (ref, question)
        isTellLifeOpen = true
    }
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
    /// The event sheet of an appointment Life added to his calendar, over the tab he was on: from its push, or its row.
    var appointment: AppointmentKey?

    /// What is on his screen for Tell Life: refs only, the tab and the matter or person on show.
    var tellScreen: TellScreen {
        let tab =
            switch tab {
            case .inbox: "inbox"
            case .projects: "projects"
            case .people: "people"
            case .search: "search"
            }
        return TellScreen(
            tab: tab,
            open: tellContext?.ref ?? tab == "projects" ? matter : tab == "people" ? person : nil)
    }

    func open(matter id: String) {
        sheet = nil
        projectAsk = nil
        tab = .projects
        matterPath = []
        select(matter: id)
        isMatterFromElsewhere = true
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

    /// The agents, from Settings' "Your agents": the Projects tab's detail column.
    func openAgents() {
        sheet = nil
        tab = .projects
        matterPath = []
        detail = .agents
        matterColumn = .detail
    }

    /// An agent's page, from wherever one is named: pushed on the Projects tab's page on show (Back returns to it), else
    /// on the agents.
    func open(agent: String) {
        sheet = nil
        matterSheet = nil
        if tab != .projects || detail == nil || matterColumn != .detail { openAgents() }
        matterPath.append(.agent(agent))
    }

    /// A person's or an organization's page, from wherever one is named: the People tab, on them.
    func open(party ref: String) {
        sheet = nil
        matterSheet = nil
        projectAsk = nil
        let from = tab
        tab = .people
        select(person: ref)
        isPersonFromElsewhere = true
        personCameFrom = from == .people ? nil : from
    }

    /// Back from the person on show to the list: to the tab he came from instead, when they were opened from elsewhere.
    func closePerson() {
        guard let from = personCameFrom else { return }
        personCameFrom = nil
        tab = from
    }

    /// The one way the person on show changes, from the list unless `open(party:)` says otherwise: their page starts
    /// bare, even when they were on show, and a compact width then shows them too, so a fold keeps them on screen.
    func select(person ref: String?) {
        people.open(ref)
        isPersonFromElsewhere = false
        personCameFrom = nil
        personColumn = ref == nil ? .sidebar : .detail
    }

    /// The one way the matter on show changes: a compact width then shows it too, so a fold keeps it on screen.
    func select(matter id: String?) {
        if matter != id { matterPath = [] }
        isMatterFromElsewhere = false
        detail = id.map { .matter($0) }
        matterColumn = id == nil ? .sidebar : .detail
    }
}
