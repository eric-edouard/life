import LifeConnector
import Observation
import SwiftUI

/// Where the app is: the tab, the chosen project chip, the ask pushed on the Inbox, and the sheet over them. One place, so
/// a card's matter chip, a push and a tapped ask all go the same way, and a fold keeps them.
@MainActor @Observable
final class AppRouter {
    enum Tab: Hashable { case inbox, projects, people, profile }
    enum Sheet: String, Identifiable {
        case pendant
        var id: String { rawValue }
    }

    /// What is pushed on the Inbox's list: the ask on show, with its pager. The list is the root, so Back returns to it.
    enum InboxPage: Hashable { case ask }
    /// What is pushed on the Profile page.
    enum ProfilePage: Hashable { case settings }

    /// A page's own Back, in the foot bar on a regular width (`NavShell`): the page registers it while it shows, and its
    /// `id` keeps a page going away from clearing the one it revealed.
    struct BackAction {
        let id: UUID
        let run: () -> Void
    }

    enum MatterSheet: Identifiable, Equatable {
        /// What wakes an agent: the one named by id, else the matter's first; an agent's page with no matter names none.
        case agent(String?, agent: String? = nil)
        /// "Start an agent" on the matter.
        case start(String)
        /// The grid that changes the matter's icon.
        case icon(String)

        var id: String {
            switch self {
            case .agent(let id, let agent): "agent-\(id ?? "")-\(agent ?? "")"
            case .start(let id): "start-\(id)"
            case .icon(let id): "icon-\(id)"
            }
        }
    }

    /// What is pushed on the detail column's page: an ask, by check ref, with the matter whose read holds it; an agent's
    /// page; a matter from an agent's page; an agent's session on pi. Back returns to the page under it.
    enum MatterRoute: Hashable {
        case card(String, matter: String)
        case agent(String)
        case matter(String)
        /// An agent's session on pi, read-only, by the agent's id.
        case session(String)
    }

    /// What the Projects tab's detail column shows: a matter, or a project's Details (decision 95), by id, the agents
    /// (`AgentsScreen`) or Spending (`SpendingPage`), both from Settings; one at a time.
    enum Detail: Hashable {
        case matter(String)
        case project(String)
        case agents
        case spending
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

    struct PagerState: Equatable {
        let current: Int
        let total: Int
    }

    var tab = Tab.inbox {
        didSet { if tab != .people { personCameFrom = nil } }
    }
    /// The tab he was on when a person was opened from elsewhere (`open(party:)`): Back from that page returns there.
    private(set) var personCameFrom: Tab?
    /// The Projects tab's chosen chip, by its identity (`ProjectChips.Chip.identity`); nil is All. Choosing one lets
    /// its list choose the matter on show again.
    var chip: String? {
        didSet {
            isMatterFromElsewhere = false
            // A chip is another list: Ask Life's cut of the matters ends.
            if chip != nil, cut?.kind == .matters { cut = nil }
        }
    }
    /// A tab's list as Ask Life cut it (`AskLifeShow.list`), under its words, until he closes it: one at a time.
    var cut: ShownList?
    /// The detail column's one page, and which column a compact width shows: the list or that page.
    private(set) var detail: Detail?
    /// The matter on show in the Projects tab, by id.
    var matter: String? {
        if case .matter(let id) = detail { id } else { nil }
    }
    var matterColumn = NavigationSplitViewColumn.sidebar
    /// The agent on show beside the agents (a regular width); nil is the first.
    var agentShown: String?
    /// Whether he opened the matter on show from elsewhere (a card's chip, a person), not from the list's rows:
    /// beside the list it then stays through a chip whose list leaves it out.
    private(set) var isMatterFromElsewhere = false
    /// A project's question, open as a sheet over the Projects tab: here, so opening a matter or a person from it
    /// closes it.
    var projectAsk: OpenAsk?
    /// What is pushed on the matter on show (`MatterRoute`): Back returns to the matter, the tab stays on Projects.
    var matterPath: [MatterRoute] = []
    /// The ask pushed on the Inbox's list; empty is the list itself.
    var inboxPath: [InboxPage] = []
    /// What is pushed on the Profile page: Settings.
    var profilePath: [ProfilePage] = []
    /// The page on show's Back, for the foot bar on a regular width.
    var back: BackAction?
    var sheet: Sheet?
    /// The list (`NavDrawer`) over the page, where it is not a sidebar.
    var isDrawerOpen = false
    /// Where the ask on show stands among the asks, for the bottom bar's dots; nil when one ask or no asks are on show.
    var pager: PagerState?
    /// Ask Life, full screen over whatever he was on.
    var isAskLifeOpen = false
    /// Whether the system puts the bars in the side column (the Duo closed or open sideways), reported by the screen on show
    /// (`reportsSideColumn`): Ask Life stands in that column's foot, else at the corner.
    var isBarsInColumn = false
    /// Ask Life's banner open: the round button's glass morphed into the dictation card above the foot bar.
    var isAskOpen = false
    /// Ask Life made small: its strip shows over the rail while there is something to keep in sight.
    var isAskLifeSmall = false
    /// What his words are about when he opens Ask Life from a card ("Wrong…"): the card's ref and its question.
    var askLifeContext: (ref: String, question: String)?

    /// What Ask Life's answer shows: the tab of a cut list, on All for the matters, or a page opened as a tap on it
    /// would; Ask Life shrinks back to its corner button, so what it shows is in view.
    func open(shown: AskLifeShow) {
        switch shown {
        case .list(let list):
            (sheet, matterSheet, projectAsk) = (nil, nil, nil)
            switch list.kind {
            case .matters:
                (tab, chip, matterColumn) = (.projects, nil, .sidebar)
            case .checks:
                (tab, inboxPath) = (.inbox, [])
            case .people:
                tab = .people
                select(person: nil)
            }
            cut = list
            // VoiceOver hears that the list is now Life's cut, not the whole list.
            AccessibilityNotification.Announcement(list.label).post()
        case .page(.matter, let id): open(matter: id)
        case .page(.person, let id): open(party: id)
        case .page(.agent, let id): open(agent: id)
        case .page(.project, let id): open(project: ProjectChips.Chip.identity(.project, id))
        }
        (isAskLifeOpen, isAskOpen, isAskLifeSmall, isDrawerOpen) = (false, false, false, false)
    }

    /// The Inbox, on its whole list, from the list's top row.
    func showHome() {
        (isDrawerOpen, tab, inboxPath, cut) = (false, .inbox, [], nil)
    }

    /// The Profile page, from the list's top row.
    func showProfile() {
        (isDrawerOpen, profilePath, tab, cut) = (false, [], .profile, nil)
    }

    /// Settings, the Profile page's child: from the list, or a screen's "Pair with Life".
    func openSettings() {
        (isDrawerOpen, tab, profilePath) = (false, .profile, [.settings])
    }

    /// The Projects page, on its whole list, from the list's top row.
    func showProjects() {
        (isDrawerOpen, tab, chip, matterColumn) = (false, .projects, nil, .sidebar)
        (detail, cut) = (nil, nil)
    }

    /// The People page, on its whole list, from the list's top row.
    func showPeople() {
        (isDrawerOpen, tab, cut) = (false, .people, nil)
        select(person: nil)
    }

    /// The cut list on show on `kind`'s tab, if Ask Life cut that one.
    func cut(of kind: ShownList.Kind) -> ShownList? { cut?.kind == kind ? cut : nil }

    /// Ask Life on a card: his words go with that card on screen.
    func askLife(about ref: String, question: String) {
        askLifeContext = (ref, question)
        isAskLifeOpen = true
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

    /// What is on his screen for Ask Life: refs only, the tab and the matter or person on show.
    var mainSessionScreen: MainSessionScreen {
        let tab =
            switch tab {
            case .inbox: "inbox"
            case .projects: "projects"
            case .people: "people"
            case .profile: "profile"
            }
        return MainSessionScreen(tab: tab, card: askLifeContext?.ref, matter: matter, person: person)
    }

    func open(matter id: String) {
        isDrawerOpen = false
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
        isDrawerOpen = false
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

    /// A page Settings opens (the agents, Spending) in the Projects tab's detail column.
    func show(_ page: Detail) {
        sheet = nil
        matterSheet = nil
        tab = .projects
        matterPath = []
        detail = page
        matterColumn = .detail
    }

    /// An agent's page, from wherever one is named: pushed on the Projects tab's page on show (Back returns to it), else
    /// on the agents.
    func open(agent: String) {
        sheet = nil
        matterSheet = nil
        if tab != .projects || detail == nil || matterColumn != .detail { show(.agents) }
        matterPath.append(.agent(agent))
    }

    /// A person's or an organization's page, from wherever one is named: the People tab, on them.
    func open(party ref: String) {
        isDrawerOpen = false
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

    /// Back from the agents beside their page, to the Projects list (a regular width): a matter is chosen again there.
    func closeAgents() {
        agentShown = nil
        detail = nil
        matterColumn = .sidebar
    }

    /// The one way the matter on show changes: a compact width then shows it too, so a fold keeps it on screen.
    func select(matter id: String?) {
        if matter != id { matterPath = [] }
        isMatterFromElsewhere = false
        detail = id.map { .matter($0) }
        matterColumn = id == nil ? .sidebar : .detail
    }
}
