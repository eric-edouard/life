import Capture
import SwiftUI
import Upload

/// Replacing the pendant: what is left on it and on this phone is uploaded first, then this phone forgets it and looks
/// for another. The pendant keeps its own pairing and audio; nothing is wiped. A lost pendant can be replaced anyway,
/// after the cost is read.
struct ReplaceSheet: View {
    /// Called once the old pendant is forgotten, to open the pairing sheet.
    let replaced: () -> Void

    @Environment(CaptureStore.self) private var capture
    @Environment(SyncStore.self) private var sync
    @Environment(\.dismiss) private var dismiss

    private enum Phase: Equatable {
        case asking, replacing
        case refused(NotOnTheMac)
        case unreachable(NotOnTheMac)

        var isFailure: Bool {
            switch self {
            case .refused, .unreachable: true
            case .asking, .replacing: false
            }
        }
    }

    @State private var phase = Phase.asking

    private var held: NotOnTheMac {
        whatIsNotOnTheMac(backlog: capture.shown.backlog, uploads: sync.uploads, now: .now)
    }

    var body: some View {
        content
            .faces(face)
            .sheetScroll {
                SheetHeader(title: title, color: phase.isFailure ? Palette.flag : Palette.fg) { dismiss() }
            } buttons: {
                VStack(spacing: Metrics.Spacing.m) { buttons }.faces(face)
            }
            .readingWidth()
            .background(Palette.sheet)
            .presentationBackground(Palette.sheet)
            .interactiveDismissDisabled(phase == .replacing)
            .accessibilityIdentifier("pendant.replaceSheet")
    }

    private var face: String {
        switch phase {
        case .asking: "asking"
        case .replacing: "replacing"
        case .refused: "refused"
        case .unreachable: "unreachable"
        }
    }

    private var title: String {
        switch phase {
        case .asking: "Replace"
        case .replacing: "Replacing"
        case .refused: "Not replaced"
        case .unreachable: "Out of reach"
        }
    }

    @ViewBuilder private var content: some View {
        switch phase {
        case .asking:
            VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                Text(held.sentence("uploaded first.") ?? "This phone forgets this pendant and looks for another.")
                    .font(.body15).foregroundStyle(Palette.muted)
            }
        case .replacing:
            RowGroup(surface: .sheet) {
                CheckLines(
                    lines: CheckLine.lines(
                        "replace", ["Uploading what is left", "Forgetting this pendant"], passed: 0, failedAt: nil,
                        isRunning: true)
                )
                .padding(Metrics.Spacing.l).frame(maxWidth: .infinity, alignment: .leading)
            }
        case .refused(let left):
            Text(
                (left.sentence("not on your Mac yet.") ?? "Some audio is not on your Mac yet.")
                    + " Keep the app open near the pendant, then try again."
            )
            .font(.body15).foregroundStyle(Palette.muted)
        case .unreachable(let left):
            VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                Text(
                    "This pendant can't be reached, so what is left on it can't be uploaded. "
                        + (left.sentence("not on your Mac yet.") ?? "Some audio is not on your Mac yet.")
                )
                .font(.body15).foregroundStyle(Palette.muted)
                if left.phoneDuration > .zero {
                    Text(
                        "If the new pendant is another model, the \(left.phoneDuration.shortWords) on this phone stop uploading until this one is paired again."
                    )
                    .font(.line).foregroundStyle(Palette.muted)
                }
            }
        }
    }

    @ViewBuilder private var buttons: some View {
        switch phase {
        case .asking:
            Button("Replace") { Task { await replace() } }.buttonStyle(.pill(.filled))
                .accessibilityIdentifier("pendant.replace.confirm")
            Button("Cancel") { dismiss() }.buttonStyle(.pill(.quiet))
        case .replacing:
            Button("Replacing…") {}.buttonStyle(.pill(.filled, isBusy: true))
        case .refused:
            Button("Try again") { Task { await replace() } }.buttonStyle(.pill(.filled))
            Button("Cancel") { dismiss() }.buttonStyle(.pill(.quiet))
        case .unreachable:
            Button("Replace anyway") { Task { await replace(anyway: true) } }.buttonStyle(.pill(.filled))
                .accessibilityIdentifier("pendant.replace.anyway")
            Button("Cancel") { dismiss() }.buttonStyle(.pill(.quiet))
        }
    }

    private func replace(anyway: Bool = false) async {
        phase = .replacing
        let outcome = await capture.replacePendant(anyway: anyway) { held }
        switch outcome {
        case .replaced:
            dismiss()
            replaced()
        case .refused(let left): phase = .refused(left)
        case .unreachable(let left): phase = .unreachable(left)
        }
    }
}
