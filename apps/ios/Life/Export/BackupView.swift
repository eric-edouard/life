import Export
import Library
import SwiftUI
import UniformTypeIdentifiers

/// "Backup & restore", linked from Settings. A full private backup is separate from ordinary exports.
struct BackupView: View {
    @Environment(\.library) private var library
    @State private var store = BackupStore()
    @State private var isChoosingBackup = false
    @State private var isConfirmingUse = false

    var body: some View {
        Form {
            if let lastSwitch = store.lastSwitch {
                Section("Last library switch") { Text(lastSwitch) }
            }
            Group {
                Section {
                    Button("Create backup") { store.backUp(library: library) }
                } footer: {
                    Text(
                        "Everything needed to restore: raw recordings, the library and its edits waiting to sync, and the "
                            + "timeline, in one ZIP with checksums. Playback audio is rebuilt from the recordings, and "
                            + "what was uploaded from the server, so both are left out."
                    )
                }
                Section {
                    Button("Restore from a backup folder") { isChoosingBackup = true }
                } footer: {
                    Text(
                        "Unzip the backup in Files first. It is checked completely, then restored into a new folder; "
                            + "the current library is never changed.")
                }
            }
            .disabled(store.isWorking)
            Section { status }
        }
        .navigationTitle("Backup & restore")
        .fileImporter(isPresented: $isChoosingBackup, allowedContentTypes: [.folder]) { result in
            switch result {
            case .success(let folder): store.restore(folder)
            case .failure: break
            }
        }
    }

    @ViewBuilder private var status: some View {
        switch store.state {
        case .idle:
            EmptyView()
        case .working(let label):
            ProgressView(label)
            Button("Cancel", role: .cancel) { store.cancel() }
        case .backedUp(let zip):
            ShareLink("Share backup", item: zip)
        case .restored(let report):
            if report.alreadyRestored {
                Text("This backup was already restored into \(report.location.lastPathComponent). Nothing changed.")
            } else {
                Text(
                    "Restored \(report.conversations) conversations and \(report.pages) recorded pages into "
                        + "\(report.location.lastPathComponent).")
            }
            ForEach(Array(report.unsupported.enumerated()), id: \.offset) { _, item in
                Text("Not restored: \(item.what). \(item.reason)")
            }
            Button("Use this restored library") { isConfirmingUse = true }
                .confirmationDialog("Use this restored library?", isPresented: $isConfirmingUse) {
                    Button("Use it from the next launch") { store.use(report) }
                } message: {
                    Text(
                        "The next time Life opens, before anything else, the current library (recordings, "
                            + "transcripts, people) is moved aside to a lifelog-previous folder in the app's "
                            + "storage, where it is kept and never deleted, and the restored library takes its place. "
                            + "Anything recorded or changed since this backup stays only in that previous folder. "
                            + "Playback audio is rebuilt from the restored recordings. If any step fails, the current "
                            + "library stays.")
                }
        case .switchScheduled:
            Text(
                "Life switches to the restored library the next time it opens. Close it from the app switcher, "
                    + "then open it again.")
        case .failed(let message):
            Text("Failed: \(message)")
            Button("OK") { store.reset() }
        }
    }
}

#if DEBUG
    #Preview {
        NavigationStack { BackupView() }
            .previewSync()
    }
#endif
