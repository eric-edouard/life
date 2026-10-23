import SwiftUI

/// Native Liquid Glass only. Bars and toolbar buttons get glass from the system; these cover the floating controls
/// the app draws itself. Group neighbouring glass in a `GlassEffectContainer` so the pieces sample each other, and
/// use `.buttonStyle(.glass)` with `.buttonBorderShape(.circle)` for round secondary controls.
extension View {
    /// A floating bar or control (the selection bar, the mini player).
    func floatingGlass(in shape: some Shape = Capsule()) -> some View {
        glassEffect(.regular, in: shape)
    }

    /// The single red primary action on a screen (play, export, save).
    func primaryGlassButton() -> some View {
        buttonStyle(.glassProminent).tint(Palette.redFill)
    }
}
