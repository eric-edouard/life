import LifeConnector
import SwiftUI

/// Which bank app a transfer card opens, one pick per kind of transfer (`BankApp`). Kept on this phone: which app opens
/// here is the phone's, never Life's.
struct AppsPage: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                ForEach(Transfers.allCases, id: \.self) { BankAppChoice(transfers: $0) }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, Metrics.Spacing.s)
            .padding(.bottom, Metrics.Spacing.xl)
            .readingWidth()
        }
        .background(Palette.sheet)
        .navigationTitle("Apps")
    }
}

/// One group: the apps of a kind of transfer, his pick checked.
private struct BankAppChoice: View {
    let transfers: Transfers
    @AppStorage private var chosen: BankApp

    init(transfers: Transfers) {
        self.transfers = transfers
        _chosen = AppStorage(wrappedValue: transfers.usual, transfers.storageKey)
    }

    var body: some View {
        RowGroup(label: transfers.title, surface: .sheet) {
            ForEach(BankApp.allCases.filter { $0.transfers == transfers }, id: \.self) { app in
                Button {
                    chosen = app
                } label: {
                    Row(title: app.name) {
                        if chosen == app {
                            Image(systemName: "checkmark").font(.smallStrong).foregroundStyle(Palette.fg)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(chosen == app ? .isSelected : [])
            }
        }
    }
}
