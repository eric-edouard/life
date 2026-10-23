import SourceStore
import SwiftUI

/// Source-store incidents waiting for the owner, as calm cards. Each holds the Pendant's pages at its index until
/// decided; nothing is ever resolved automatically.
struct IncidentCards: View {
    let incidents: [IncidentItem]
    let resolve: ([IncidentItem.ID], IncidentResolution) async throws -> Void

    var body: some View {
        ForEach(incidents) { incident in
            IncidentCard(incident: incident) { try await resolve(incident.ids, $0) }
        }
    }
}

/// What a card shows of an open source-store incident, or of a run of pages with the same problem.
struct IncidentItem: Equatable, Identifiable {
    var id: Int64
    var kind: IncidentKind
    var index: UInt64
    var detail: String
    var recordedAt: Date
    /// Roughly when the page's audio was recorded, by the Pendant's clock; `nil` when nothing near it says.
    var audioAt: Date?
    /// The incidents on the pages right after `index`, shown and settled with this one (`grouped()`).
    var following: [Int64] = []
    /// Roughly when the last page's audio was recorded, for a run of pages.
    var audioEnd: Date?

    var ids: [Int64] { [id] + following }
    var lastIndex: UInt64 { index + UInt64(following.count) }
}

extension IncidentItem {
    init(_ incident: Incident, audioAt: Date?) {
        self.init(
            id: incident.id, kind: incident.kind, index: incident.key.index, detail: incident.detail,
            recordedAt: incident.recordedAt, audioAt: audioAt)
    }
}

extension [IncidentItem] {
    /// Consecutive pages with the same problem, settled as gaps, share one card; its action settles each page as its
    /// own card would.
    func grouped() -> [IncidentItem] {
        reduce(into: []) { cards, item in
            guard let last = cards.last, last.kind == item.kind, item.kind.choices == [.gap],
                item.index == last.lastIndex + 1
            else { return cards.append(item) }
            cards[cards.count - 1].following.append(item.id)
            if let at = item.audioAt { cards[cards.count - 1].audioEnd = at }
        }
    }
}

private struct IncidentCard: View {
    let incident: IncidentItem
    let resolve: (IncidentResolution) async throws -> Void

    @State private var choice: IncidentResolution?
    @State private var error: String?

    private var pages: Int { incident.ids.count }

    var body: some View {
        AttentionCard(
            id: "pendant.card.incident.\(incident.kind.rawValue)", title: title, systemImage: "exclamationmark.octagon",
            detail: explanation
                + (incident.kind.holdsPendant
                    ? " Until you decide, Life keeps these pages on the Pendant and clears nothing past them." : "")
                + (error.map { " That didn't work: \($0)" } ?? ""),
            footnote: "Found \(incident.recordedAt.moment) · "
                + (pages == 1 ? "page \(incident.index)" : "pages \(incident.index)–\(incident.lastIndex)")
        ) {
            ForEach(incident.kind.choices, id: \.self) { resolution in
                Button(resolution.action(pages: pages)) { choice = resolution }
                    .buttonStyle(.glass)
                    .accessibilityIdentifier("pendant.incident.\(resolution)")
            }
        }
        // A centered alert, not a popover: a popover anchored to the card spilled over the tab bar, and its button
        // then landed on a tab.
        .alert("Are you sure?", item: $choice) { resolution in
            Button("Cancel", role: .cancel) {}
                .accessibilityIdentifier("pendant.incident.cancel")
            Button(resolution.action(pages: pages)) {
                Task {
                    do {
                        try await resolve(resolution)
                        error = nil
                    } catch {
                        self.error = report(error)
                    }
                }
            }
            .accessibilityIdentifier("pendant.incident.confirm")
        } message: { resolution in
            Text(resolution.consequence(pages: pages))
        }
    }

    /// What it means for the owner, in time rather than page numbers; the raw pages are in the footnote.
    private var title: String {
        let around = incident.audioAt.map { " around \($0.moment)" } ?? ""
        return switch incident.kind {
        case .replayConflict: "Two versions of a few seconds of audio\(around)"
        case .encryptedAudio: "\(amount) of audio\(around) are encrypted"
        case .undecodablePage: "\(amount) of audio\(around) came in a form Life can't read"
        case .checksumMismatch: "A few seconds of saved audio\(around) are damaged"
        case .unreadablePage: "\(amount) of audio\(around) couldn't be read"
        }
    }

    /// How much audio a run of pages spans, by the Pendant's times at either end.
    private var amount: String {
        guard let start = incident.audioAt, let end = incident.audioEnd else { return "A few seconds" }
        let seconds = Int(end.timeIntervalSince(start).rounded())
        if seconds < 5 { return "A few seconds" }
        if seconds < 90 { return "About \(seconds) seconds" }
        return "About \(Int((Double(seconds) / 60).rounded())) minutes"
    }

    private var these: String { pages == 1 ? "this page" : "these \(pages) pages" }
    private var them: String { pages == 1 ? "it" : "them" }

    private var explanation: String {
        switch incident.kind {
        case .replayConflict:
            "The Pendant sent this page again with different content (\(incident.detail)). Both copies are kept on this iPhone; choose which one your recordings use."
        case .encryptedAudio:
            "Another app turned on audio encryption, so Life can't play \(these). Restarting the Pendant stops it for new recordings. You can let \(them) go as a marked gap."
        case .undecodablePage:
            "Life couldn't decode \(these) (\(incident.detail)). A later version may read \(them). You can let \(them) go as a marked gap; the raw bytes stay on this iPhone."
        case .unreadablePage:
            pages == 1
                ? "Its audio can't be recovered: \(incident.detail). It's a marked gap in your recordings, its raw bytes are kept on this iPhone, and sync moved on."
                : "This audio can't be recovered: \(incident.detail). It's a marked gap in your recordings, the raw bytes of its \(pages) pages are kept on this iPhone, and sync moved on."
        case .checksumMismatch:
            "The saved copy no longer matches what arrived. The next sync repairs it from the Pendant's copy; nothing to do."
        }
    }
}

extension IncidentKind {
    /// The owner's options. A damaged copy has none: a replay repairs it.
    fileprivate var choices: [IncidentResolution] {
        switch self {
        case .replayConflict: [.storedCopy, .replayCopy]
        case .encryptedAudio, .undecodablePage, .unreadablePage: [.gap]
        case .checksumMismatch: []
        }
    }

    /// Every open incident but a lost page keeps its pages on the Pendant until it's settled.
    fileprivate var holdsPendant: Bool { self != .unreadablePage }
}

extension IncidentResolution {
    fileprivate func action(pages: Int) -> String {
        switch self {
        case .storedCopy: "Keep the saved copy"
        case .replayCopy: "Use the Pendant's new copy"
        case .gap: pages == 1 ? "Accept as a gap" : "Accept as gaps"
        case .repaired: "Repaired"
        }
    }

    fileprivate func consequence(pages: Int) -> String {
        switch self {
        case .storedCopy:
            "Recordings keep the copy saved first. The Pendant's new copy stays on this iPhone as evidence."
        case .replayCopy: "Recordings use the Pendant's new copy. The first copy stays on this iPhone as evidence."
        case .gap:
            pages == 1
                ? "The page stays a marked gap in your recordings. Its bytes stay on this iPhone as evidence, and sync can move past it on the Pendant."
                : "These \(pages) pages stay a marked gap in your recordings. Their bytes stay on this iPhone as evidence, and sync can move past them on the Pendant."
        case .repaired: ""
        }
    }
}

#if DEBUG
    /// One of each kind, then runs of unreadable and undecodable pages, which share a card each.
    private let previewIncidents: [IncidentItem] =
        [
            IncidentItem(
                id: 1, kind: .replayConflict, index: 1_204, detail: "device time differs", recordedAt: .now,
                audioAt: .now.addingTimeInterval(-3_600)),
            IncidentItem(id: 2, kind: .encryptedAudio, index: 88, detail: "", recordedAt: .now),
            IncidentItem(id: 3, kind: .checksumMismatch, index: 7, detail: "", recordedAt: .now),
            IncidentItem(
                id: 4, kind: .unreadablePage, index: 1_099_511_627_886, detail: "the Pendant reported it corrupt",
                recordedAt: .now, audioAt: .now),
        ]
        + (0..<4).map { offset in
            IncidentItem(
                id: 5 + Int64(offset), kind: .unreadablePage, index: 1_099_511_687_981 + UInt64(offset),
                detail: "the Pendant couldn't read it", recordedAt: .now,
                audioAt: .now.addingTimeInterval(Double(offset) * 2))
        }
        + (0..<3).map { offset in
            IncidentItem(
                id: 9 + Int64(offset), kind: .undecodablePage, index: 1_099_511_688_100 + UInt64(offset),
                detail: "flash page has no timestamp", recordedAt: .now)
        }

    #Preview("Incidents") {
        ScrollView {
            VStack(spacing: 12) {
                IncidentCards(incidents: previewIncidents.grouped(), resolve: { _, _ in })
            }
            .padding(16)
        }
        .background(Palette.ground)
        .preferredColorScheme(.dark)
    }
#endif
