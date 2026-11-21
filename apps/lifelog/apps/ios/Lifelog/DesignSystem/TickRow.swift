import SwiftUI

/// A row he ticks in a bulk ask (`pick_rows`, the batch close's rows): the round mark at its left, which a tap flips;
/// its body, which a tap opens; and an unticked row at 45%, unless it has nothing to tick yet (a row that needs him:
/// its own card says who), which stays at full strength.
struct TickRow<Content: View>: View {
    let isTicked: Bool
    var isTickable = true
    let tick: () -> Void
    let open: () -> Void
    @ViewBuilder var content: Content

    var body: some View {
        HStack(spacing: Metrics.Spacing.m) {
            Button(action: tick) {
                Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(Palette.fg)
                    .opacity(isTicked ? 1 : 0)
                    .frame(width: 24, height: 24).background(isTicked ? Color.pick : Color.fillTint, in: .circle)
                    .frame(minWidth: Metrics.tapTarget, minHeight: Metrics.tapTarget).contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Tick").accessibilityValue(isTicked ? "Ticked" : "Not ticked")
            content.frame(maxWidth: .infinity, alignment: .leading).contentShape(.rect).onTapGesture(perform: open)
                .accessibilityAddTraits(.isButton).accessibilityAction(named: "Open", open)
        }
        .frame(minHeight: Metrics.FlatRow.bulkRow)
        .opacity(isTicked || !isTickable ? 1 : 0.45)
        .motion(Motion.standard, value: isTicked)
    }
}
