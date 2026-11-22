import SwiftUI

/// The Profile page (the nav prototype's, his "design ref" of 22 Nov): Spending, then his devices (the Mac, the
/// Pendant), then Life's own (Vocabulary, Apps, Your data), then every other setting, each a page pushed on it. Not
/// Settings: Settings is its last row.
struct ProfileScreen: View {
    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $router.profilePath) {
            ScrollView {
                VStack(spacing: Metrics.Spacing.l) {
                    RowGroup {
                        row("Spending", "chart.bar", id: "profile.spending") { router.show(.spending) }
                    }
                    RowGroup(label: "Devices") {
                        link("Mac", "desktopcomputer", value: life.pairedOrigin?.addressWords ?? "Not paired") {
                            ConnectionPage(connection: .life)
                        }
                        row("Pendant", "record.circle", id: "profile.pendant") { router.sheet = .pendant }
                    }
                    RowGroup(label: "Life") {
                        link("Vocabulary", "textformat") { VocabularyView() }
                        link("Apps", "square.grid.2x2") { AppsPage() }
                        link("Your data", "square.and.arrow.up") { BackupView() }
                    }
                    RowGroup {
                        row("Settings", "gearshape", id: "profile.settings") { router.openSettings() }
                    }
                }
                .padding(.horizontal, Metrics.gutter).padding(.top, Metrics.Spacing.s).readingWidth()
            }
            .background(Palette.bg)
            .screenTitle("Profile")
            .shellBar("")
            .navigationDestination(for: AppRouter.ProfilePage.self) { _ in SettingsPage() }
        }
    }

    private func row(_ title: String, _ icon: String, id: String, open: @escaping () -> Void) -> some View {
        Button(action: open) { Row(title: title, icon: icon) { RowValue() } }
            .buttonStyle(.plain)
            .accessibilityIdentifier(id)
    }

    private func link(
        _ title: String, _ icon: String, value: String? = nil, @ViewBuilder page: () -> some View
    ) -> some View {
        NavigationLink {
            page()
        } label: {
            Row(title: title, icon: icon) { RowValue(text: value) }
        }
        .buttonStyle(.plain)
    }
}
