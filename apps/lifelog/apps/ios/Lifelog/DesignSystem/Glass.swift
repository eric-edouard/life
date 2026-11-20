import SwiftUI

/// Native Liquid Glass only. Bars and toolbar buttons get glass from the system; these cover the floating controls
/// the app draws itself. Group neighbouring glass in a `GlassEffectContainer` so the pieces sample each other, and
/// use `.buttonStyle(.glass)` with `.buttonBorderShape(.circle)` for round secondary controls.
extension View {
    /// A floating bar or control (the selection bar, the mini player).
    func floatingGlass(in shape: some Shape = Capsule()) -> some View {
        glassEffect(.regular, in: shape)
    }

    /// A screen's one floating primary action: cream glass, its label dark like every cream fill's (`PillStyle`);
    /// left to the system, the label is light and vanishes on the cream.
    func primaryGlassButton() -> some View {
        buttonStyle(.glassProminent).tint(Palette.fg).foregroundStyle(Palette.on)
    }
}
