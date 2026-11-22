import LifeConnector
import SwiftUI

/// The one shell (navigation v3, no tabs): the page on show (the Inbox, Projects, People or Profile), the list
/// (`HomeList`) placed by the pose (`AppRouter.pose`), and the bottom bar: the asks' page dots, room for Ask Life, and on
/// the open Duo the list's button at the page's left, next to the sidebar. Stacked (a phone, the closed Duo) the list is
/// the Inbox page's root and nothing sits in the bar's left.
struct NavShell: View {
    @Environment(AppRouter.self) private var router
    @Environment(\.horizontalSizeClass) private var sizeClass

    private var isSidebar: Bool { router.pose == .sideways && router.isListShown }
    private let sidebarWidth: CGFloat = 380

    var body: some View {
        HStack(spacing: 0) {
            if isSidebar {
                NavigationStack { HomeList() }.frame(width: sidebarWidth)
                Divider().overlay(Palette.line)
            }
            page
        }
        .overlay {
            if router.pose == .upright, router.isListShown { panel }
        }
        // Ask Life's veil: over the page and the list, under the bar, which stays sharp and usable.
        .overlay { AskLifeVeil() }
        .overlay(alignment: .bottom) { bar }
        // The pose's inputs, reported once here: the window's width and its aspect.
        .onGeometryChange(for: Bool.self, of: { $0.size.width > $0.size.height }) { router.isLandscape = $0 }
        .onChange(of: sizeClass, initial: true) { _, size in router.isRegular = size == .regular }
        // A new pose starts with its own list: the sidebar sideways, nothing over the page upright.
        .onChange(of: router.pose, initial: true) { _, pose in router.isListShown = pose == .sideways }
        .motion(Motion.standard, value: router.isListShown)
    }

    @ViewBuilder private var page: some View {
        switch router.tab {
        case .inbox: InboxScreen()
        case .projects: ProjectsScreen()
        case .people: PeopleScreen()
        case .profile: ProfileScreen()
        }
    }

    /// Upright, the list is a panel over the page, dimmed behind it.
    private var panel: some View {
        ZStack(alignment: .leading) {
            Color.black.opacity(0.4).ignoresSafeArea().onTapGesture { router.isListShown = false }
            NavigationStack { HomeList() }.frame(width: 420).transition(.move(edge: .leading))
        }
    }

    /// The list's button (open poses only, at the page's left: next to the sidebar), the dots of the asks, and room for
    /// Ask Life's button.
    private var bar: some View {
        HStack {
            if router.pose != .stacked { ListButton() }
            Spacer(minLength: 0)
            if let pager = router.pager, router.tab == .inbox, router.pose != .upright || !router.isListShown {
                PagerDots(current: pager.current, total: pager.total)
            }
            Spacer(minLength: 0)
            Color.clear.frame(width: 48, height: 48)
        }
        .padding(.horizontal, 20).padding(.bottom, 31)
        // Past the sidebar and its divider.
        .padding(.leading, isSidebar ? sidebarWidth + 1 : 0)
        // Over the column's room on a Duo, Ask Life stands in the column (its own place): no room kept for it here.
        .padding(.trailing, router.isBarsInColumn ? 98 : 0)
        .ignoresSafeArea()
    }
}

/// The list's button on the open Duo: shows or hides the sidebar, opens or closes the panel. One glass circle.
private struct ListButton: View {
    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life

    var body: some View {
        Button {
            router.isListShown.toggle()
        } label: {
            ShellCircle(symbol: router.isListShown ? "xmark" : "line.3.horizontal")
                // Something waits on him in the Inbox while the list is away.
                .overlay(alignment: .topTrailing) {
                    if life.badge > 0, router.tab != .inbox, !router.isListShown {
                        StateDot(color: Palette.flag).offset(x: -4, y: 4)
                    }
                }
        }
        .accessibilityLabel(router.isListShown ? "Close the list" : "Open the list")
        .accessibilityIdentifier("shell.list")
    }
}

/// Profile as one glass circle in the Duo's column, at its foot above Ask Life.
struct ProfileButton: View {
    @Environment(AppRouter.self) private var router

    var body: some View {
        Button {
            router.showProfile()
        } label: {
            ShellCircle(symbol: "person")
        }
        .accessibilityLabel("Profile")
        .accessibilityIdentifier("column.profile")
    }
}

/// The shell's own round glass button face (the list's button, Profile's).
private struct ShellCircle: View {
    let symbol: String

    var body: some View {
        Image(systemName: symbol).font(.system(size: 18, weight: .medium))
            .foregroundStyle(Palette.fg).frame(width: 48, height: 48)
            .glassEffect(.regular.interactive(), in: .circle)
    }
}
