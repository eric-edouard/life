import Library
import LifeConnector
import ServerAPI
import SwiftUI
import Upload

/// One connection's page, for Life and the pendant server alike: whether it works, where it is paired, "Check now" with
/// the lines it ticks, and "Pair again" by pasting the link. Everything it shows is a state the stores already hold
/// (`LifeStore.link`, `SyncStore.summary`), the same ones the Settings row and Diagnostics read. The server's page also
/// says what waits for it and the edits it refused.
struct ConnectionPage: View {
    let connection: Connection
    @Environment(SyncStore.self) private var sync
    @Environment(LifeStore.self) private var life
    @Environment(\.openURL) private var openURL
    @State private var isChecking = false
    @State private var isChecked = false
    @State private var refusal: String?

    private var address: URL? { connection == .life ? life.pairedOrigin : sync.server }
    private var link: LinkState { connection == .life ? life.link : sync.link }
    private var outcome: CheckOutcome { connection == .life ? life.outcome : sync.outcome }
    private var checkedAt: Date? { connection == .life ? life.inbox.loadedAt : sync.feed.pulledAt }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                status
                if address != nil {
                    if let lines { RowGroup(surface: .sheet) { CheckLines(lines: lines).padding(16) } }
                    RowGroup(surface: .sheet) {
                        Row(title: "Address") {
                            Text(address?.addressWords ?? "").font(.note).foregroundStyle(Palette.muted)
                        }
                    }
                    if connection == .server { waiting }
                }
                actions
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 8)
            .padding(.bottom, 24)
            .readingWidth()
        }
        .background(Palette.sheet)
        .navigationTitle(connection.name)
        .accessibilityIdentifier("connection.\(connection.id)")
    }

    // MARK: Status

    private var status: some View {
        VStack(alignment: .leading, spacing: 6) {
            (isChecking ? LinkState.checking : link).mark
            if address == nil {
                Text(
                    connection == .life
                        ? "Inbox and Matters need Life on your Mac." : "Recording goes on; nothing is sent."
                )
                .font(.note).foregroundStyle(Palette.muted)
            } else if let reason = isChecking ? nil : ConnectionCheck.reason(connection, outcome) {
                Text(reason).font(.note).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            } else if let checkedAt {
                Text("Checked \(checkedAt.formatted(.relative(presentation: .named)))").font(.small)
                    .foregroundStyle(Palette.muted)
            }
        }
    }

    /// The three lines: under way while it checks, then what the state says; none until something was checked or failed.
    private var lines: [CheckLine]? {
        if isChecking { return ConnectionCheck.lines(connection, nil) }
        if outcome != .works || isChecked { return ConnectionCheck.lines(connection, outcome) }
        return nil
    }

    // MARK: What waits (the server)

    @ViewBuilder private var waiting: some View {
        let summary = sync.summary
        RowGroup(label: "Waiting", surface: .sheet) {
            if let uploads = sync.uploads, uploads.unsent > .zero {
                Row(title: "Audio to upload") {
                    Text(DurationText.string(uploads.unsent, width: .wide)).font(.note).foregroundStyle(Palette.muted)
                }
            }
            if let error = sync.uploads?.lastError {
                // It tries again on its own; the owner sees why it hasn't gone yet.
                Row(title: "Upload failing", detail: error) { StateGlyph.flag }
            }
            if summary.editsWaiting > 0 {
                Row(title: "Your edits to send") {
                    Text("\(summary.editsWaiting)").font(.note).foregroundStyle(Palette.muted)
                }
            }
            if let backup = sync.backup, backup.packs + backup.jobs > 0 {
                let files = backup.packs + backup.jobs
                Row(title: "Recordings to back up") {
                    Text(files == 1 ? "1 file" : "\(files) files").font(.note).foregroundStyle(Palette.muted)
                }
            }
            ForEach(sync.waiting.sorted { $0.key.rawValue < $1.key.rawValue }, id: \.key) { reason, count in
                Row(title: reason.sentence) {
                    Text(conversationCount(count)).font(.note).foregroundStyle(Palette.muted)
                }
            }
        }
        RowGroup(label: "Refused by the server", labelColor: Palette.flag, surface: .sheet) {
            ForEach(sync.pending.refused, id: \.id) { edit in
                Row(title: Self.name(edit.intent), detail: edit.refused) {
                    RowButton(title: "OK") { Task { await sync.dismiss(edit.id) } }
                }
            }
        }
    }

    private static func name(_ intent: OwnerIntent) -> String {
        switch intent {
        case .switches: "A setting"
        case .vocabulary: "The word list"
        case .playbackQuiet: "A played-out stretch"
        }
    }

    // MARK: Actions

    @ViewBuilder private var actions: some View {
        VStack(alignment: .leading, spacing: 12) {
            if address != nil {
                if outcome == .works || isChecking {
                    Button("Check now") { Task { await check() } }.buttonStyle(.pill(.quiet, isBusy: isChecking))
                        .accessibilityIdentifier("connection.check")
                } else {
                    Button("Try again") { Task { await check() } }.buttonStyle(.pill(.filled))
                        .accessibilityIdentifier("connection.check")
                }
            }
            RowGroup(surface: .sheet) {
                Row(
                    title: address == nil ? "Pair" : "Pair again",
                    detail: "Open the link Life shows on your Mac with the Camera, or paste it."
                ) {
                    PasteButton(payloadType: String.self) { pasted in
                        guard let text = pasted.first?.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
                        // Only a pairing link goes on; the token it carries is never drawn.
                        if let url = URL(string: text), PairOffer(link: url) != nil {
                            refusal = nil
                            openURL(url)
                        } else {
                            refusal = "That isn't a pairing link."
                        }
                    }
                    .labelStyle(.titleOnly).buttonBorderShape(.capsule)
                }
            }
            if let refusal { Text(refusal).font(.note).foregroundStyle(Palette.flag) }
        }
    }

    private func check() async {
        isChecking = true
        if connection == .life { await life.refreshInbox() } else { await sync.checkNow() }
        isChecking = false
        isChecked = true
    }
}
