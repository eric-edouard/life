import SwiftUI

/// A filter chip: its name, after its icon when it has one; filled when it holds a choice. A chip of the Projects tab
/// (decision 95) also shows the flag dot when something in it needs him and the spinner while an agent works on it,
/// and is dimmed when its project is parked or done.
struct FilterChip: View {
    let name: String
    var icon: String?
    var isOn = false
    var needsYou = false
    var isWorking = false
    var isDimmed = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Metrics.Spacing.s) {
                if let icon { Image(systemName: icon).font(.chip).accessibilityHidden(true) }
                Text(name).font(.chip)
                if needsYou { StateDot(color: Palette.flag) }
                if isWorking { Spinner(size: .small).foregroundStyle(Palette.ai) }
            }
            .foregroundStyle(isOn ? Palette.on : Palette.fg)
            .padding(.horizontal, 15)
            .frame(minHeight: 40)
            .background(isOn ? Palette.fg : Palette.card, in: .capsule)
            .opacity(isDimmed && !isOn ? 0.45 : 1)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .motion(Motion.standard, value: isOn)
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .accessibilityValue(
            [needsYou ? "Needs you" : nil, isDimmed ? "Parked" : nil].compactMap(\.self).joined(separator: ", "))
    }
}
