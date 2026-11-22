import LifeConnector
import SwiftUI

/// The Projects page (nav v3): the projects underway, his areas as chips, then the parked and done projects, in Life's
/// order (`read_projects`). A project's row opens its page (`AppRouter.chip`). No agent mark shows anywhere: what Life does
/// on a project is not his to watch.
struct ProjectsList: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    var body: some View {
        let chips = life.projects.shown(isEmpty: { $0.chips.isEmpty })
        return ReadScreen(
            shown: chips,
            stamp: life.projects.stamp,
            retry: { await life.refreshProjects() },
            loading: { RowsPlaceholder(label: "Loading the projects") },
            empty: {
                Notice(
                    title: "No projects yet.",
                    detail: "The projects and areas Life reads from your matters show here.")
            },
            content: { read in list(read) }
        )
        .motion(Motion.standard, value: chips.onScreen?.chips.map(\.identity))
    }

    private func list(_ read: ProjectChips) -> some View {
        let sections = read.sections
        return List {
            rows(sections.underway, detail: underwayLine)
            if !sections.areas.isEmpty {
                ListLabel("Areas").quietListRow()
                FlowLayout(spacing: Metrics.Spacing.s) {
                    ForEach(sections.areas, id: \.identity) { chip in
                        FilterChip(
                            name: chip.name, icon: MatterIcons.areaSymbol(chip.area ?? chip.id),
                            isOn: router.chip == chip.identity, needsYou: chip.needYou > 0
                        ) {
                            router.chip = chip.identity
                        }
                        .accessibilityIdentifier("projects.chip.\(chip.id)")
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, Metrics.Spacing.s)
                .quietListRow()
            }
            if !sections.parked.isEmpty {
                ListLabel("Parked · \(sections.parked.count)").quietListRow()
                rows(sections.parked, detail: { _ in "Parked" }, isDimmed: true)
            }
            if !sections.done.isEmpty {
                ListLabel("Done · \(sections.done.count)").quietListRow()
                rows(sections.done, detail: { _ in "Done" }, isDimmed: true)
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden)
        .safeAreaPadding(.bottom, Metrics.Spacing.xl)
        .scrollDismissesKeyboard(.interactively)
    }

    /// A section's project rows, each with its status and counts; a long press offers its status and Details.
    private func rows(
        _ chips: [ProjectChips.Chip], detail: @escaping (ProjectChips.Chip) -> String, isDimmed: Bool = false
    ) -> some View {
        ForEach(Array(chips.enumerated()), id: \.element.identity) { at, chip in
            Button {
                router.chip = chip.identity
            } label: {
                Row(
                    title: chip.name, icon: MatterIcons.fallback, iconTint: Palette.muted, detail: detail(chip),
                    isInList: true
                ) {
                    if chip.needYou > 0 { StateDot(color: Palette.flag) }
                    RowValue()
                }
                .opacity(isDimmed ? 0.45 : 1)
            }
            .buttonStyle(.groupedRow(at: at, of: chips.count))
            .contextMenu {
                if let status = chip.status { menu(chip, status: life.status(of: chip.id, as: status)) }
            }
            .accessibilityIdentifier("projects.row.\(chip.id)")
            .readingWidth()
            .appears()
            .quietListRow()
        }
    }

    /// "Underway · 9 matters · 3 wait on you": what the part is zero is left out.
    private func underwayLine(_ chip: ProjectChips.Chip) -> String {
        [
            "Underway",
            chip.matters == 0 ? nil : chip.matters == 1 ? "1 matter" : "\(chip.matters) matters",
            chip.needYou == 0 ? nil : chip.needYou == 1 ? "1 waits on you" : "\(chip.needYou) wait on you",
        ]
        .compactMap(\.self).joined(separator: " · ")
    }

    /// A project's row, pressed long: its status in one tap each way (said back with Undo; he stays on the page),
    /// and its Details.
    @ViewBuilder private func menu(_ chip: ProjectChips.Chip, status: ProjectStatus) -> some View {
        let set = { (to: ProjectStatus, words: String) -> Void in
            Task { await life.setStatus(of: chip.id, named: chip.name, to: to, was: status, words: words) }
        }
        if status.isUnderway {
            Button("Park", systemImage: "square") { set(.parked, "Parked") }
        } else {
            Button("Underway", systemImage: "arrow.uturn.backward") { set(.active, "Underway") }
        }
        if status != .done { Button("Mark done", systemImage: "checkmark") { set(.done, "Done") } }
        Button("Details", systemImage: "info.circle") { router.openDetails(of: chip.id) }
    }
}
