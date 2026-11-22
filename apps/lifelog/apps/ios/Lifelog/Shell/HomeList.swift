import LifeConnector
import SwiftUI

/// The list, titled Life: Projects, People and Profile, then the asks (the one inbox: what blocks, then what can wait),
/// then the matters that don't wait on him, by Priority (Waiting on others, Moving) or Latest. The Inbox page's root on a
/// phone and the closed Duo (an ask pushed on it, the pages replacing it), the sidebar sideways and a panel upright
/// (`NavShell`). With the Filter on Your moves it is the moves' list.
struct HomeList: View {
    enum Order: String, CaseIterable {
        case priority = "Priority", latest = "Latest"
    }

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    /// Remembered: the order he last chose.
    @AppStorage("drawerOrder") private var order = Order.priority

    var body: some View {
        @Bindable var router = router
        let asks = router.asks.shown(life.inboxOnShow, kind: router.asks.kind, cut: router.cut(of: .checks))
        Group {
            if router.asks.kind == .yourMove {
                MovesList(checks: router.asks.all(life.inboxOnShow).only(.yourMove).checks)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        CutToast(kind: .checks)
                        VStack(spacing: 0) {
                            page(
                                "Projects", "folder",
                                count: life.projects.value?.chips.filter { $0.kind == .project }.count
                            ) {
                                router.showProjects()
                            }
                            page("People", "person.2", count: life.people.value?.people.count) { router.showPeople() }
                            page("Profile", "person", count: nil) { router.showProfile() }
                                .accessibilityIdentifier("drawer.profile")
                        }
                        .padding(.horizontal, Metrics.Spacing.s)
                        Divider().overlay(Palette.line).padding(.vertical, Metrics.Spacing.s)
                        CheckList(order: asks) { ref in
                            if let taken = router.asks.notes.taken { life.forget(taken.key) }
                            router.open(ask: ref)
                        }
                        switcher.padding(.top, Metrics.Spacing.m)
                        switch order {
                        case .priority: priority
                        case .latest: latest
                        }
                    }
                    .padding(.bottom, 24).readingWidth()
                }
                .motion(Motion.standard, value: order)
                .screenTitle("Life", state: life.waiting.flatMap { $0 > 0 ? "\($0) waiting" : nil })
            }
        }
        .background(Palette.bg)
        .askFilterBar(kinds: router.asks.all(life.inboxOnShow).kinds, kind: $router.asks.kind)
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

    /// The matters that don't wait on him (the asks above are what does), by where they stand.
    @ViewBuilder private var priority: some View {
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
