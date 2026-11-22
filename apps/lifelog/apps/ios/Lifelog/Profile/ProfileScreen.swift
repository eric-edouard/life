import SwiftUI

/// The Profile page, from the list: his settings for now, pushed on it. The page itself is being built elsewhere, so this
/// is its one row until then.
struct ProfileScreen: View {
    @Environment(AppRouter.self) private var router

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $router.profilePath) {
            ScrollView {
                RowGroup {
                    Button {
                        router.openSettings()
                    } label: {
                        Row(title: "Settings", icon: "gearshape") { RowValue() }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("profile.settings")
                }
                .padding(.horizontal, Metrics.gutter).padding(.top, Metrics.Spacing.s).readingWidth()
            }
            .background(Palette.bg)
            .screenTitle("Profile")
            .shellBar("")
            .navigationDestination(for: AppRouter.ProfilePage.self) { _ in SettingsPage() }
        }
    }
}
