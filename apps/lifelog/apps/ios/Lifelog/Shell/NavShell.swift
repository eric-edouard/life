import LifeConnector
import SwiftUI

/// The one shell (navigation v3, no tabs): the page on show (the asks' list, Projects, People or Profile), the list
/// (`NavDrawer`) beside or over it by pose, and the bottom bar: the slot at the left (the list's button on a compact width;
/// on a regular one it and Back sit in the top group under the Pendant), the asks' page dots in the middle, Ask Life's at the right. A phone and a folded Duo
/// give the list a screen of its own; an upright open Duo a panel over the page; sideways, a sidebar the button hides.
struct NavShell: View {
    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var isSideways: Bool { router.isSideways }
    private var isListShown: Bool { router.isListShown }

    var body: some View {
        HStack(spacing: 0) {
            if isSideways, !router.isSidebarHidden {
                NavDrawer().frame(width: 380)
                Divider().overlay(Palette.line)
            }
            page
        }
        .overlay {
            if !isSideways, router.isDrawerOpen { overlayList }
        }
        // Ask Life's veil: over the page and the list, under the bar, which stays sharp and usable.
        .overlay { AskLifeVeil() }
        .overlay(alignment: .bottom) { bar }
        .onGeometryChange(for: Bool.self, of: { $0.size.width > $0.size.height }) {
            router.isSideways = $0 && sizeClass == .regular
            if isSideways { router.isDrawerOpen = false }
        }
        .motion(Motion.standard, value: isListShown)
    }

    @ViewBuilder private var page: some View {
        switch router.tab {
        case .inbox: InboxScreen()
        case .projects: ProjectsScreen()
        case .people: PeopleScreen()
        case .profile: ProfileScreen()
        }
    }

    /// A screen of its own on a compact width, else a panel with the page dimmed behind it.
    @ViewBuilder private var overlayList: some View {
        if sizeClass == .regular {
            ZStack(alignment: .leading) {
                Color.black.opacity(0.4).ignoresSafeArea().onTapGesture { router.isDrawerOpen = false }
                NavDrawer().frame(width: 420).transition(.move(edge: .leading))
            }
        } else {
            NavDrawer().transition(.opacity)
        }
    }

    /// The bar's slot (the list's button; on a regular width it is the top group's, beside the Pendant, so no corner
    /// holds it), the dots of the asks, and room for Ask Life's button.
    private var bar: some View {
        HStack {
            if sizeClass != .regular { ListButton() }
            Spacer(minLength: 0)
            if let pager = router.pager, router.tab == .inbox, !isListShown {
                PagerDots(current: pager.current, total: pager.total)
            }
            Spacer(minLength: 0)
            Color.clear.frame(width: 48, height: 48)
        }
        .padding(.horizontal, 20).padding(.bottom, 31)
        // Over the column's room on a Duo, Ask Life stands in the column (its own place): no room kept for it here.
        .padding(.trailing, router.isBarsInColumn ? 98 : 0)
        .ignoresSafeArea()
    }
}

/// The list's button: the foot bar's slot on a compact width, the top group's on a regular one (`ShellBar`), one glass circle.
struct ListButton: View {
    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life

    var body: some View {
        Button {
            router.toggleList()
        } label: {
            Image(systemName: router.isListShown ? "xmark" : "line.3.horizontal")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Palette.fg).frame(width: 48, height: 48)
                .glassEffect(.regular.interactive(), in: .circle)
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
