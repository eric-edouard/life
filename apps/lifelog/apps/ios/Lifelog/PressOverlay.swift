import ServerAPI
import SwiftUI
import UIKit

/// A press of the Pendant's button, as it happens (`ButtonActions.shown`): a glass card rising from the bottom over
/// whatever is open, sheets included, with the HAL lens as its emblem. Each stage replaces the last in place; the
/// ready words come with Claude and ChatGPT to ask. A tap outside or a swipe down puts it away.
struct PressOverlay: View {
    @Environment(ButtonActions.self) private var buttons
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drag: CGFloat = 0

    var body: some View {
        ZStack(alignment: .bottom) {
            if let state = buttons.shown {
                Color.black.opacity(0.45).ignoresSafeArea()
                    .onTapGesture(perform: buttons.dismiss)
                    .accessibilityHidden(true)
                    .transition(.opacity)
                card(state)
                    .offset(y: max(drag, 0))
                    .gesture(
                        DragGesture()
                            .onChanged { drag = $0.translation.height }
                            .onEnded {
                                if $0.predictedEndTranslation.height > 120 { buttons.dismiss() }
                                withMotion(Motion.rise) { drag = 0 }
                            }
                    )
                    .accessibilityAction(.escape, buttons.dismiss)
                    .transition(
                        reduceMotion
                            ? .opacity : .move(edge: .bottom).combined(with: .scale(scale: 0.9, anchor: .bottom))
                    )
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.2) : Motion.rise, value: buttons.shown)
        .sensoryFeedback(trigger: buttons.shown) { _, state in
            switch state?.stage {
            case .heard?: .impact(weight: .medium)
            case .ready?: .success
            case .failed?: .error
            default: nil
            }
        }
        .tint(Palette.redText)
        .preferredColorScheme(.dark)
    }

    private func card(_ state: PressState) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            PressHeading(hearing: !state.ended, progress: state.ended ? nil : state.progress)
            stage(state)
                .id(state.stage)
                .transition(.blurReplace(.upUp))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(22)
        .card(radius: 34)
        .shadow(color: .black.opacity(0.5), radius: 30, y: 12)
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }

    @ViewBuilder private func stage(_ state: PressState) -> some View {
        switch state.stage {
        case .heard: headline("Heard.")
        case .listening: headline("Listening back over the last minute.")
        case .transcribing: headline("Transcribing.")
        case .ready(let words):
            VStack(alignment: .leading, spacing: 18) {
                ScrollView {
                    Text(words)
                        .font(.spokenQuote)
                        .foregroundStyle(Palette.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxHeight: 280)
                .fixedSize(horizontal: false, vertical: true)
                GlassEffectContainer { AskButtons(words: words) }.controlSize(.large)
            }
        case .failed(let reason):
            VStack(alignment: .leading, spacing: 8) {
                headline("That didn't work.")
                Text(reason).font(.subheadline).foregroundStyle(Palette.textSecondary)
                Button("Try again", systemImage: "arrow.clockwise", action: buttons.retry)
                    .buttonStyle(.glass)
                    .padding(.top, 10)
            }
        }
    }

    private func headline(_ text: String) -> some View {
        Text(text).font(.readerTitle).foregroundStyle(Palette.textPrimary)
    }

    /// Its own window above the app's, so it shows over any screen or sheet. It takes touches only while a press shows.
    static func install(_ buttons: ButtonActions) {
        guard window == nil,
            let scene = UIApplication.shared.connectedScenes.lazy.compactMap({ $0 as? UIWindowScene }).first
        else { return }
        let window = PressWindow(windowScene: scene)
        window.buttons = buttons
        let host = UIHostingController(rootView: PressOverlay().environment(buttons))
        host.view.backgroundColor = .clear
        window.rootViewController = host
        window.windowLevel = .normal + 1
        window.isHidden = false
        Self.window = window
    }

    private static var window: UIWindow?
}

/// A press's heading, on the overlay and on each card of the Presses tab: the lens, what it is and its window.
struct PressHeading: View {
    var light = HALLens.Light.lit
    var hearing = false
    var progress: Double?
    var at: Date?

    var body: some View {
        HStack(spacing: 14) {
            HALLens(light: light, hearing: hearing, progress: progress, diameter: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text("Quick question to AI")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.textPrimary)
                Text(at.map { "\($0.formatted(date: .omitted, time: .shortened)) · 1 min" } ?? "1 min")
                    .font(.monoDetail)
                    .foregroundStyle(Palette.textTertiary)
            }
        }
    }
}

/// Claude and ChatGPT, side by side, to ask about the words: glass, inside the caller's `GlassEffectContainer`.
struct AskButtons: View {
    let words: String
    @Environment(ButtonActions.self) private var buttons
    @State private var asked = 0

    var body: some View {
        HStack(spacing: 10) {
            Button("Ask Claude") { ask(.claude) }.primaryGlassButton()
            Button("Ask ChatGPT") { ask(.chatgpt) }.buttonStyle(.glass)
        }
        .buttonSizing(.flexible)
        .foregroundStyle(Palette.textPrimary)
        .sensoryFeedback(.impact(weight: .light), trigger: asked)
    }

    private func ask(_ app: QuickQuestion.App) {
        asked += 1
        Task {
            await ButtonActions.ask(app, words)
            buttons.dismiss()
        }
    }
}

private final class PressWindow: UIWindow {
    weak var buttons: ButtonActions?

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        buttons?.shown == nil ? nil : super.hitTest(point, with: event)
    }
}
