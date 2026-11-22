import SwiftUI

/// A filter chip: its name, after its icon when it has one; filled when it holds a choice, with the flag dot when
/// something in it needs him.
struct FilterChip: View {
    let name: String
    var icon: String?
    var isOn = false
    var needsYou = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Metrics.Spacing.s) {
                if let icon { Image(systemName: icon).font(.chip).accessibilityHidden(true) }
                Text(name).font(.chip)
                if needsYou { StateDot(color: Palette.flag) }
            }
            .foregroundStyle(isOn ? Palette.on : Palette.fg)
            .padding(.horizontal, 15)
            .frame(minHeight: 40)
            .background(isOn ? Palette.fg : Palette.card, in: .capsule)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .motion(Motion.standard, value: isOn)
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .accessibilityValue(needsYou ? "Needs you" : "")
    }
}
