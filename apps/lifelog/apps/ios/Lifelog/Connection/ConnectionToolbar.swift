import SwiftUI

extension View {
    /// Every main tab's sync status, at the leading end of its bar: a symbol alone while all is well, with words when
    /// the phone is offline, uploads or edits wait. Tapping it shows what waits and why. Nothing without a
    /// `SyncStore` in the environment (previews).
    func connectionStatus() -> some View { modifier(ConnectionToolbar()) }
}

private struct ConnectionToolbar: ViewModifier {
    @Environment(SyncStore.self) private var sync: SyncStore?
    @State private var showsDetails = false

    func body(content: Content) -> some View {
        content
            .toolbar {
                if let sync {
                    ToolbarItem(placement: .topBarLeading) {
                        ConnectionButton(summary: sync.summary) { showsDetails = true }
                    }
                }
            }
            .sheet(isPresented: $showsDetails) {
                if let sync { ConnectionSheet(sync: sync) }
            }
    }
}

struct ConnectionButton: View {
    let summary: ConnectionSummary
    let open: () -> Void

    var body: some View {
        let state = summary.state
        // No TimelineView here: inside a bar item it kept UIKit relaying out the navigation bar every frame, a main
        // thread at 100% (2026-10-11).
        Button(action: open) {
            if let text = state.toolbarText {
                // Text, not a Label: the bar would draw a Label as its icon alone.
                Text("\(Image(systemName: state.systemImage)) \(text)").font(.subheadline).fixedSize()
            } else {
                Label(state.title, systemImage: state.systemImage).labelStyle(.iconOnly)
            }
        }
        // Quiet unless offline; the words and the symbol carry the meaning, never the colour.
        .tint(state == .offline ? Palette.textPrimary : Palette.textSecondary)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Shows what waits for the server and why")
        .accessibilityIdentifier("connection.status")
    }

    private var accessibilityLabel: String {
        if case .upToDate(let synced?) = summary.state {
            return "Up to date, synced \(synced.formatted(.relative(presentation: .named)))"
        }
        return summary.state.title
    }
}
