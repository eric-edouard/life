import LifeConnector
import SwiftUI

/// Navigation v3's one list: Projects and People on top, then every matter by Priority (Waiting on you, Can wait,
/// Waiting on others, Moving) or Latest, and Profile at the foot. A full screen on a phone and a folded Duo, a panel over
/// the page on an upright open Duo, the sidebar sideways (`NavShell`). A tap opens the page and puts the list away.
struct NavDrawer: View {
    enum Order: String, CaseIterable {
        case priority = "Priority", latest = "Latest"
    }

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @Environment(\.topBarZoom) private var topBarZoom
    /// Remembered: the order he last chose.
    @AppStorage("drawerOrder") private var order = Order.priority

    var body: some View {
        // The Pendant stays on its line, as on every page, and the first row shares it.
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                CutToast(kind: .checks)
                page("Projects", "folder", count: life.projects.value?.chips.filter { $0.kind == .project }.count) {
                    router.showProjects()
                }
                .padding(.trailing, 52)
                page("People", "person.2", count: life.people.value?.people.count) { router.showPeople() }
                // Profile is Settings until its page is built (a sheet today).
                page("Profile", "person", count: nil) {
                    router.isDrawerOpen = false
                    router.sheet = .settings
                }
                .zoomSource(AppRouter.Sheet.settings, in: topBarZoom)
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
        .overlay(alignment: .topTrailing) {
            PendantItem { router.sheet = .pendant }.frame(width: 44, height: 44).padding(.trailing, Metrics.Spacing.s)
        }
        // Room for the bottom bar, which stays over the list.
        .safeAreaPadding(.bottom, 80)
        .background(Palette.bg)
        .motion(Motion.standard, value: order)
    }

    // MARK: Top

    private func page(_ title: String, _ symbol: String, count: Int?, open: @escaping () -> Void) -> some View {
        Button(action: open) {
            Row(title: title, icon: symbol) {
                if let count { Text("\(count)").font(.small).foregroundStyle(Palette.muted) }
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

    /// What waits on him, an ask each (every ask is its own row, none folded); then each matter by where it stands.
    @ViewBuilder private var priority: some View {
        let asks = life.inboxOnShow?.ordered(deferred: []).checks ?? []
        let split = asks.firstIndex { $0.urgency == .improves } ?? asks.count
        let asked = Set(asks.compactMap(\.matterID))
        let rest = matters.filter { !asked.contains($0.id) }
        group("Waiting on you", count: split, asks: Array(asks[..<split]))
        group("Can wait", asks: Array(asks[split...]))
        group("Waiting on others", matters: rest.filter { $0.status == .waitingOnSomeone })
        group("Moving", matters: rest.filter { $0.status != .waitingOnSomeone })
    }

    private var latest: some View {
        group(nil, matters: matters.sorted { ($0.lastStepAt ?? .distantPast) > ($1.lastStepAt ?? .distantPast) })
    }

    private var matters: [MatterRow] { life.matters.value?.matters ?? [] }

    @ViewBuilder private func group(_ label: String?, count: Int? = nil, asks: [Check]) -> some View {
        if !asks.isEmpty {
            heading(label, count: count)
            ForEach(Array(asks.enumerated()), id: \.element.ref) { at, check in
                Button {
                    router.isDrawerOpen = false
                    Task { await life.open(ref: check.ref) }
                    router.tab = .inbox
                } label: {
                    Row(
                        title: check.question, icon: nil,
                        detail: check.beingFixed == nil ? check.listLine() : "Being fixed", isInList: true
                    ) {
                        if check.beingFixed != nil {
                            StateGlyph.busy
                        } else if let deadline = check.deadline {
                            Text(DeadlineWords.when(deadline)).font(.small).foregroundStyle(Palette.flag)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                .buttonStyle(.groupedRow(at: at, of: asks.count))
                .contextMenu { actions(of: check).menu }
                .rowSwipe(main: actions(of: check).main, drop: actions(of: check).drop)
            }
        }
    }

    private func actions(of check: Check) -> AskRowActions {
        AskRowActions(check: check, life: life) {
            router.isDrawerOpen = false
            Task { await life.open(ref: check.ref) }
            router.tab = .inbox
        }
    }

    @ViewBuilder private func group(_ label: String?, matters rows: [MatterRow]) -> some View {
        if !rows.isEmpty {
            heading(label, count: nil)
            ForEach(Array(rows.enumerated()), id: \.element.id) { at, row in
                Button {
                    router.isDrawerOpen = false
                    router.open(matter: row.id)
                } label: {
                    MatterRowView(row: row, isMarked: life.isImportant(row.id, as: row.important))
                }
                .buttonStyle(.groupedRow(at: at, of: rows.count))
                .contextMenu {
                    AskRowActions.mark(row, life)
                    Button("Done", systemImage: "checkmark") { Task { await life.markDone(row.id) } }
                }
            }
        }
    }

    @ViewBuilder private func heading(_ label: String?, count: Int?) -> some View {
        if let label {
            ListLabel(label) {
                if let count { Text("\(count)").font(.small).foregroundStyle(Palette.flag) }
            }
            .padding(.top, Metrics.Spacing.m)
        }
    }
}
