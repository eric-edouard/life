import Library
import ServerAPI
import SwiftUI

/// What the sync status stands for: the state in words, what waits and why, and the edits the server refused.
struct ConnectionSheet: View {
    let sync: SyncStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let summary = sync.summary
        let state = summary.state
        NavigationStack {
            TimelineView(.everyMinute) { _ in
                List {
                    Section {
                        Label {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(state.title).font(.headline)
                                Text(state.detail).font(.subheadline).foregroundStyle(Palette.muted)
                            }
                        } icon: {
                            Image(systemName: state.systemImage)
                        }
                        .accessibilityElement(children: .combine)
                    }
                    Section("Waiting") {
                        if !summary.uploading && summary.editsWaiting == 0 && sync.waiting.isEmpty {
                            Text("Nothing waits.")
                        }
                        if let uploads = sync.uploads, uploads.unsent > .zero {
                            waits(
                                "Audio to upload", systemImage: "icloud.and.arrow.up",
                                DurationText.string(uploads.unsent, width: .wide))
                        }
                        if let error = sync.uploads?.lastError {
                            // It tries again on its own; the owner sees why it hasn't gone yet.
                            VStack(alignment: .leading, spacing: 4) {
                                waits("Upload failing", systemImage: "exclamationmark.icloud", "")
                                Text(error).font(.footnote).foregroundStyle(Palette.muted)
                            }
                        }
                        if summary.editsWaiting > 0 {
                            waits(
                                "Your edits to send", systemImage: "arrow.triangle.2.circlepath",
                                "\(summary.editsWaiting)")
                        }
                        if let backup = sync.backup, backup.packs + backup.jobs > 0 {
                            waits(
                                "Recordings to back up", systemImage: "externaldrive",
                                files(backup.packs + backup.jobs))
                        }
                        ForEach(sync.waiting.sorted { $0.key.rawValue < $1.key.rawValue }, id: \.key) { reason, count in
                            waits(
                                reason.sentence, systemImage: reason.systemImage,
                                conversationCount(count))
                        }
                    }
                    if !sync.pending.refused.isEmpty {
                        Section("Refused by the server") {
                            ForEach(sync.pending.refused, id: \.id) { edit in
                                RefusedEdit(edit: edit) { Task { await sync.dismiss(edit.id) } }
                            }
                        }
                    }
                    Section {
                        LabeledContent("Last sync", value: ago(summary.lastPull))
                        LabeledContent("Network", value: summary.network.name)
                    } footer: {
                        Text(
                            "Edits and titles show at once and stay on this phone until the server has them. Everything here works offline."
                        )
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.bg)
            .tint(Palette.fg)
            .navigationTitle("Sync")
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Palette.bg)
    }

    private func waits(_ title: String, systemImage: String, _ value: String) -> some View {
        LabeledContent {
            Text(value)
        } label: {
            Label(title, systemImage: systemImage).labelStyle(.decorativeIcon)
        }
    }

    private func files(_ count: Int) -> String { count == 1 ? "1 file" : "\(count) files" }

    private func ago(_ date: Date?) -> String {
        guard let date else { return "Not yet" }
        return date.formatted(.relative(presentation: .named, unitsStyle: .wide))
    }
}

/// An edit the server refused: what it was, the server's reason, and OK to let it go.
private struct RefusedEdit: View {
    let edit: OutboxEntry
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text(Self.name(edit.intent)).font(.subheadline.weight(.semibold))
                Text(edit.refused ?? "").font(.subheadline).foregroundStyle(Palette.muted)
            }
            Spacer(minLength: 8)
            Button("OK", action: dismiss)
                .buttonStyle(.glass)
                .accessibilityHint("Lets the refused edit go")
        }
    }

    static func name(_ intent: OwnerIntent) -> String {
        switch intent {
        case .switches: "A setting"
        case .vocabulary: "The word list"
        case .playbackQuiet: "A played-out stretch"
        }
    }
}
