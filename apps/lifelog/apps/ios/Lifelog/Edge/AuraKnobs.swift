import LifeConnector
import SwiftUI

/// What the edge draws now: his saved look, or the halo settings' draft while he tunes, and the state they show.
/// Saved is a cache of Life's answer to his Save (`change_setting`, the `aura` setting the source of truth), so the
/// edge keeps his look at launch. ponytail: a fresh install draws the default until a developer bakes his values in;
/// add a read of the setting when a second phone needs it.
@MainActor @Observable final class AuraPreview {
    static let shared = AuraPreview()
    var shown: AuraSetting
    /// The state the halo settings show on the edge while open; nil: Life's own.
    var state: EdgeState?
    private(set) var saved: AuraSetting
    private static let key = "aura"
    /// Whether the edge is drawn at all: off until he turns it on in the halo settings. The phone's own choice.
    static let isOnKey = "isAuraOn"

    private init() {
        let cached = UserDefaults.standard.data(forKey: Self.key).flatMap {
            try? JSONDecoder().decode(AuraSetting.self, from: $0)
        }
        saved = cached ?? .standard
        shown = cached ?? .standard
    }

    /// Life kept `aura`: the edge draws it from now on.
    func keep(_ aura: AuraSetting) {
        saved = aura
        shown = aura
        UserDefaults.standard.set(try? JSONEncoder().encode(aura), forKey: Self.key)
    }
}

/// The halo settings: the settings block's `aura` key, in Ask Life's answer. Its switch draws the edge at all (off
/// by default); every slider moves the real edge at once;
/// Save keeps the values as Life's `aura` setting.
struct AuraBlock: View {
    @Environment(LifeStore.self) private var life
    @State private var state = EdgeState.rest
    @State private var saving = RowState.known
    @AppStorage(AuraPreview.isOnKey) private var isOn = false
    private let preview = AuraPreview.shared

    var body: some View {
        @Bindable var preview = preview
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            Toggle("Halo", isOn: $isOn.animation())
            if isOn {
                AuraKnobs(aura: $preview.shown, state: $state)
                HStack(spacing: Metrics.Spacing.s) {
                    RowButton(title: "Default") { preview.shown = .standard }
                    RowButton(title: "Undo") { preview.shown = preview.saved }.disabled(preview.shown == preview.saved)
                    Spacer(minLength: 0)
                    Button("Save") { Task { await RowState.tap($saving) { await save() } } }
                        .buttonStyle(.pill(.filled, size: .compact, isBusy: saving == .saving))
                }
                TapLine(state: saving)
            }
        }
        .padding(.vertical, Metrics.Spacing.m)
        .onAppear { preview.state = state }
        .onChange(of: state) { preview.state = state }
        .onDisappear { preview.state = nil }
    }

    private func save() async -> RowState {
        do {
            preview.keep(try await life.saveAura(preview.shown))
            return .saved
        } catch {
            return .refused("Not saved: \(error.localizedDescription)")
        }
    }
}

/// Every value of the edge as a control: the state shown, the colour, that state's values, then the border, the glow,
/// the rings, each turning light and the pool. Ranges are the `aura` setting's (`core/settings.ts`).
struct AuraKnobs: View {
    @Binding var aura: AuraSetting
    @Binding var state: EdgeState

    static let stateNames: [EdgeState: String] = [
        .rest: "Idle", .speaking: "You speak", .working: "Working", .still: "No Mac",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            SegmentedChoice(
                choices: [EdgeState.rest, .speaking, .working, .still],
                selection: Binding(get: { state }, set: { state = $0 ?? state }),
                title: { Self.stateNames[$0] ?? "" })
            colours
            group(Self.stateNames[state] ?? "") {
                knob("Speed", $aura[state].speed, 0...4, "×")
                knob("Brightness", $aura[state].brightness, 0...1)
                knob("Glow width", $aura[state].glow, 0...40, "pt")
                knob("Glow blur", $aura[state].blur, 0...40, "pt")
                knob("Colour", $aura[state].colour, 0...1)
                knob("Lights", $aura[state].lights, 0...1)
                knob("Pool", $aura[state].pool, 0...1)
            }
            group("Border") {
                knob("Width", $aura.line.width, 0...4, "pt")
                knob("Opacity", $aura.line.opacity, 0...1)
            }
            group("Glow and rings") {
                knob("Glow opacity", $aura.glowOpacity, 0...1)
                knob("Calm ring", $aura.rings.calm, 0...1)
                knob("Working ring", $aura.rings.work, 0...1)
                knob("Pool radius", $aura.poolRadius, 40...600, "pt")
            }
            light("First light", $aura.lights[0])
            light("Second light", $aura.lights[1])
            light("Working arc", $aura.arc)
        }
    }

    private var colours: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: Metrics.tapTarget), spacing: Metrics.Spacing.s)],
                spacing: Metrics.Spacing.s
            ) {
                ForEach(Array(AuraSetting.choices.enumerated()), id: \.offset) { swatch($0.offset, $0.element.color) }
            }
            Text(AuraSetting.choices[aura.colour].name).font(.line).foregroundStyle(Palette.muted)
        }
    }

    private func swatch(_ index: Int, _ color: Color) -> some View {
        Button {
            aura.colour = index
        } label: {
            Circle().fill(color).frame(width: Metrics.swatch, height: Metrics.swatch)
                .overlay {
                    if aura.colour == index {
                        Image(systemName: "checkmark").font(.lineStrong).foregroundStyle(Palette.on)
                    }
                }
                .frame(width: Metrics.tapTarget, height: Metrics.tapTarget)
        }
        .buttonStyle(.plain).accessibilityLabel(AuraSetting.choices[index].name)
    }

    private func light(_ title: String, _ light: Binding<AuraSetting.Light>) -> some View {
        group(title) {
            knob("Opacity", light.opacity, 0...1)
            knob("One turn", light.seconds, 1...120, "s")
            Toggle("Clockwise", isOn: light.clockwise).font(.rowTitle).tint(Palette.ai)
            knob("Bright part peaks", light.peak, 0.01...max(light.wrappedValue.end - 0.01, 0.02))
            knob("Bright part ends", light.end, min(light.wrappedValue.peak + 0.01, 0.99)...1)
            knob("Strength", light.gain, 0...5, "×")
        }
    }

    private func group(_ title: String, @ViewBuilder _ knobs: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            Text(title).font(.lineStrong).foregroundStyle(Palette.muted).padding(.top, Metrics.Spacing.s)
            knobs()
        }
    }

    private func knob(_ title: String, _ value: Binding<Double>, _ range: ClosedRange<Double>, _ unit: String = "")
        -> some View
    {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(title).font(.rowTitle)
                Spacer(minLength: 0)
                Text(value.wrappedValue.formatted(.number.precision(.fractionLength(0...2))) + unit)
                    .font(.line).monospacedDigit().foregroundStyle(Palette.muted)
            }
            Slider(value: value, in: range).tint(Palette.fg).accessibilityLabel(title)
        }
    }
}
