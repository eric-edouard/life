import ServerAPI
import SwiftUI

/// The Profile page (the nav prototype's, his "design ref" of 22 Nov): Spending, then his devices (the Mac, the Pendant,
/// the Pendant server), then Life's own (Vocabulary, Apps, Your data), each with its value, then Settings: every page
/// typed on `AppRouter.profilePath`, so opening Profile or Settings always lands where it says.
struct ProfileScreen: View {
    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life
    @Environment(SyncStore.self) private var sync

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $router.profilePath) {
            ScrollView {
                VStack(spacing: Metrics.Spacing.l) {
                    RowGroup {
                        row("Spending", "chart.bar", id: "profile.spending") { router.show(.spending) }
                    }
                    RowGroup(label: "Devices") {
                        row(
                            "Mac", "desktopcomputer", value: life.pairedOrigin?.addressWords ?? "Not paired",
                            id: "settings.life"
                        ) {
                            router.profilePath.append(.connection(.life))
                        }
                        row("Pendant", "record.circle", id: "profile.pendant") { router.sheet = .pendant }
                        row(
                            "Pendant server", "cloud", value: sync.server?.addressWords ?? "Not paired",
                            id: "pendant.settings.server"
                        ) { router.profilePath.append(.connection(.server)) }
                    }
                    RowGroup(label: "Life") {
                        row("Vocabulary", "textformat", value: vocabulary, id: "settings.vocabulary") {
                            router.profilePath.append(.vocabulary)
                        }
                        row("Apps", "square.grid.2x2", id: "settings.apps") { router.profilePath.append(.apps) }
                        row("Your data", "square.and.arrow.up", value: backup, id: "pendant.settings.backup") {
                            router.profilePath.append(.backup)
                        }
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
            .navigationDestination(for: AppRouter.ProfilePage.self) { page in
                switch page {
                case .settings: SettingsPage()
                case .vocabulary: VocabularyView()
                case .apps: AppsPage()
                case .backup: BackupView()
                case .connection(let connection): ConnectionPage(connection: connection)
                }
            }
        }
    }

    private func row(
        _ title: String, _ icon: String, value: String? = nil, id: String, open: @escaping () -> Void
    ) -> some View {
        Button(action: open) { Row(title: title, icon: icon) { RowValue(text: value) } }
            .buttonStyle(.plain)
            .accessibilityIdentifier(id)
    }

    /// "12 words", once the server's list is known.
    private var vocabulary: String? {
        serverVocabulary(feed: sync.feed.vocabulary, pending: sync.pending).shown
            .map { $0.count == 1 ? "1 word" : "\($0.count) words" }
    }

    /// When the last backup was made; nil until the status is read.
    private var backup: String? {
        guard sync.server != nil else { return "Not paired" }
        guard let backup = sync.backup else { return nil }
        guard let at = backup.snapshot?.recordedAt else { return "None yet" }
        let time = at.formatted(date: .omitted, time: .shortened)
        if Calendar.current.isDateInToday(at) { return "Today, \(time)" }
        if Calendar.current.isDateInYesterday(at) { return "Yesterday, \(time)" }
        return at.formatted(date: .abbreviated, time: .shortened)
    }
}
