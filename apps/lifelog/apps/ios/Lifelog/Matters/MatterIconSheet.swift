import LifeConnector
import SwiftUI

/// A matter's icon, changed: the whole set in its groups, the icon shown chosen and who chose it. His tap wins, and
/// “Let Life pick” gives it back; either closes the sheet once Life has it, said back on the page with Undo
/// (`LifeStore.setMatterIcon`). With no icon from Life (none picked, or a key this build lacks), nothing is chosen
/// and nothing claims a pick.
struct MatterIconSheet: View {
    let matter: String

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss
    /// His tap, chosen at once while Life records it.
    @State private var tapped: String?

    var body: some View {
        let row = life.matter[matter]?.value?.row
        let isRunning = life.state(of: .edit(matter: matter, .icon)).isRunning
        VStack(alignment: .leading, spacing: 0) {
            SheetHeader(title: nil) { dismiss() }.frame(minHeight: Metrics.tapTarget)
                .overlay(alignment: .leading) {
                    Text(row?.name ?? "").font(.sheetQuestion).foregroundStyle(Palette.fg).lineLimit(1)
                        .padding(.trailing, Metrics.tapTarget + Metrics.Spacing.s)
                }
            if let row { attribution(row, isRunning: isRunning) }
            ScrollView {
                IconGrid(groups: MatterIcons.groups, chosen: tapped ?? row?.knownIcon?.key) { key in
                    if let row { choose(key, row: row) }
                }
                .disabled(isRunning)
                .padding(.top, Metrics.Spacing.m).padding(.bottom, Metrics.Spacing.xl)
            }
            .scrollEdgeEffectStyle(.soft, for: .bottom)
        }
        .padding(.horizontal, Metrics.gutter).padding(.top, Metrics.Spacing.s)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.sheet)
        .sheetStack()
        .presentationDetents([.large])
    }

    /// Who chose the icon shown: Life, or he (with the way back to Life's); a busy mark while his tap is recorded.
    private func attribution(_ row: MatterRow, isRunning: Bool) -> some View {
        HStack {
            switch row.knownIcon?.by {
            case .owner?: Text("Your choice")
            case .life?: Text("Life picked this one")
            default: EmptyView()
            }
            Spacer(minLength: 0)
            if isRunning {
                Spinner(size: .small).foregroundStyle(Palette.muted)
            } else if row.knownIcon?.by == .owner {
                TextLink("Let Life pick", isMuted: false) { choose(nil, row: row) }
            }
        }
        .font(.small).foregroundStyle(Palette.muted)
        .motion(Motion.standard, value: isRunning)
    }

    /// Sends his pick (nil: Life picks again), keeping his pick before it for Undo; his own pick tapped again only
    /// closes the sheet.
    private func choose(_ key: String?, row: MatterRow) {
        let was = row.ownerIconKey
        guard key != was else { return dismiss() }
        tapped = key
        Task {
            await life.setMatterIcon(of: matter, key, was: was)
            if router.matterSheet == .icon(matter) { router.matterSheet = nil }
        }
    }
}
