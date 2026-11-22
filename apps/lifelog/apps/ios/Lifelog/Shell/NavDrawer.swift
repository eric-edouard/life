import LifeConnector
import SwiftUI

/// Navigation v3's one list: Home (the Inbox), Projects, People and Profile on top, then every matter by Priority (Waiting
/// on you, Waiting on others, Moving) or Latest. A full screen on a phone and a folded Duo, a panel over the page on an
/// upright open Duo, the sidebar sideways (`NavShell`). A tap opens the page and puts the list away.
struct NavDrawer: View {
    enum Order: String, CaseIterable {
        case priority = "Priority", latest = "Latest"
    }

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// Remembered: the order he last chose.
    @AppStorage("drawerOrder") private var order = Order.priority

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                CutToast(kind: .checks)
                page("Home", "tray", count: life.waiting) { router.showHome() }
                    // A compact width draws the list's own Pendant over this first row.
                    .padding(.trailing, sizeClass == .regular ? 0 : 52)
                page("Projects", "folder", count: life.projects.value?.chips.filter { $0.kind == .project }.count) {
                    router.showProjects()
                }
                page("People", "person.2", count: life.people.value?.people.count) { router.showPeople() }
                page("Profile", "person", count: nil) { router.showProfile() }
                    .accessibilityIdentifier("drawer.profile")
                Divider().overlay(Palette.line).padding(.vertical, Metrics.Spacing.s)
                switcher
                switch order {
                case .priority: priority
                case .latest: latest
                }
            }
            .padding(.horizontal, Metrics.Spacing.s).readingWidth()
        }
        // Beside the page's own Pendant (a regular width), the list keeps none of its own.
        .overlay(alignment: .topTrailing) {
            if sizeClass != .regular {
                PendantItem { router.sheet = .pendant }.frame(width: 44, height: 44)
                    .padding(.trailing, Metrics.Spacing.s)
            }
        }
        // Room for the bottom bar, which stays over the list.
        .safeAreaPadding(.bottom, 80)
        .background(Palette.bg)
        .motion(Motion.standard, value: order)
    }

    // MARK: Top

    /// A row's count, when it has one.
    private func page(_ title: String, _ symbol: String, count: Int?, open: @escaping () -> Void) -> some View {
        Button(action: open) {
            Row(title: title, icon: symbol) {
                if let count, count > 0 { Text("\(count)").font(.small).foregroundStyle(Palette.muted) }
            }
        }
        .buttonStyle(.plain)
    }

    private var switcher: some View {
        HStack(spacing: 0) {
            ForEach(Order.allCases, id: \.self) { choice in
                Button(choice.rawValue) { order = choice }
                    .font(.small).foregroundStyle(order == choice ? Palette.fg : Palette.muted)
                    .frame(maxWidth: .infinity, minHeight: 36)
                    .background(order == choice ? Color.pick : .clear, in: Capsule())
                    .accessibilityAddTraits(order == choice ? .isSelected : [])
            }
        }
        .padding(3).background(Color.fillTint, in: Capsule()).buttonStyle(.plain)
        .padding(.bottom, Metrics.Spacing.s)
    }

    // MARK: Priority

    /// Every matter by where it stands, the ones that need him first.
    @ViewBuilder private var priority: some View {
        group("Waiting on you", matters: matters.filter { $0.needsYou == true })
        group("Waiting on others", matters: matters.filter { $0.needsYou != true && $0.status == .waitingOnSomeone })
        group("Moving", matters: matters.filter { $0.needsYou != true && $0.status != .waitingOnSomeone })
    }

    private var latest: some View {
        group(nil, matters: matters.sorted { ($0.lastStepAt ?? .distantPast) > ($1.lastStepAt ?? .distantPast) })
    }

    private var matters: [MatterRow] { life.matters.value?.matters ?? [] }

    @ViewBuilder private func group(_ label: String?, matters rows: [MatterRow]) -> some View {
        if !rows.isEmpty {
            heading(label)
            ForEach(Array(rows.enumerated()), id: \.element.id) { at, row in
                Button {
                    router.isDrawerOpen = false
                    router.open(matter: row.id)
                } label: {
                    MatterRowView(row: row, isMarked: life.isImportant(row.id, as: row.important))
                }
                .buttonStyle(.groupedRow(at: at, of: rows.count))
                .contextMenu {
                    // His mark on it, as the matter's own page has it.
                    let isMarked = life.isImportant(row.id, as: row.important)
                    Button(
                        isMarked ? "Not important" : "Mark important",
                        systemImage: isMarked ? "flag.slash" : "flag"
                    ) {
                        Task { await life.setImportant(row.id, !isMarked) }
                    }
                    Button("Done", systemImage: "checkmark") { Task { await life.markDone(row.id) } }
                }
            }
        }
    }

    @ViewBuilder private func heading(_ label: String?) -> some View {
        if let label {
            ListLabel(label).padding(.top, Metrics.Spacing.m)
        }
    }
}
