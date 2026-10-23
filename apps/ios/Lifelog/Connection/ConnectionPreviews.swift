#if DEBUG
    import SwiftUI

    private func bar(_ summary: ConnectionSummary) -> some View {
        NavigationStack {
            Color.clear
                .background(Palette.ground)
                .navigationTitle("Library")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { ConnectionButton(summary: summary) {} }
                }
        }
        .preferredColorScheme(.dark)
    }

    #Preview("Up to date") { bar(ConnectionSummary(network: .wifi, lastPull: .now - 120)) }
    #Preview("Never synced") { bar(ConnectionSummary(network: .wifi)) }
    #Preview("Uploading") { bar(ConnectionSummary(network: .wifi, uploading: true, lastPull: .now - 300)) }
    #Preview("Edits waiting") { bar(ConnectionSummary(network: .cellular, editsWaiting: 2, lastPull: .now - 300)) }
    #Preview("Offline") {
        bar(ConnectionSummary(network: .none, uploading: true, editsWaiting: 2, lastPull: .now - 3600))
    }
    #Preview("Sheet") {
        Color.clear.sheet(isPresented: .constant(true)) { ConnectionSheet(sync: .preview()) }
            .preferredColorScheme(.dark)
    }
#endif
