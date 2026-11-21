import LifeConnector
import SwiftUI

/// Every read has the same five faces (brief rule 5): loading, empty, stale, unreachable, failed, and not paired. A screen gives only its
/// content and its empty and loading looks; the rest is here, so no screen draws a blank.
struct ReadScreen<Value: Sendable, Content: View, Loading: View, Empty: View>: View {
    let shown: ReadState<Value>.Shown
    let retry: () async -> Void
    @ViewBuilder let loading: Loading
    @ViewBuilder let empty: Empty
    @ViewBuilder let content: (Value) -> Content

    @Environment(AppRouter.self) private var router
    @Environment(LifeStore.self) private var life

    private static func reason(_ why: ReadState<Value>.Why) -> String {
        switch why {
        case .unreachable: "Your Mac is out of reach."
        case .failed(let reason): reason
        }
    }

    var body: some View {
        // Each face fades out as the next fades in (loading to content: the spinner goes as the content comes).
        ZStack { face.appears(Motion.fade).id(faceName) }
            // The network back: what is on show is read again, whatever screen it is.
            .onChange(of: life.hasPath) { _, hasPath in if hasPath { Task { await retry() } } }
    }

    /// Which face shows, so a new face fades in and a new value of the same face changes in place.
    private var faceName: String {
        switch shown {
        case .loading: "loading"
        case .loaded: "loaded"
        case .empty: "empty"
        case .stale: "stale"
        case .unreachable: "unreachable"
        case .failed: "failed"
        case .notPaired: "notPaired"
        }
    }

    /// Out of reach, what shows is what was last read and nothing can be done on it: said above it, in place.
    private func withOutOfReach(_ shown: some View) -> some View {
        VStack(spacing: 0) {
            if let why = life.whyOutOfReach { StaleNote(since: nil, because: why, retry: retry) }
            shown
        }
    }

    @ViewBuilder private var face: some View {
        switch shown {
        case .loading: loading
        case .loaded(let value): withOutOfReach(content(value))
        case .empty: withOutOfReach(empty)
        case .stale(let value, let since, let why):
            VStack(spacing: 0) {
                StaleNote(since: since, because: Self.reason(why), retry: retry)
                content(value)
            }
        case .unreachable:
            Notice(
                title: "Your Mac is out of reach.",
                detail: "Life runs on your Mac. This shows again once the phone reaches it.",
                action: ("Try again", { Task { await retry() } }))
        case .failed(let reason):
            Notice(title: "Life didn't answer.", detail: reason, action: ("Try again", { Task { await retry() } }))
        case .notPaired:
            Notice(
                title: "Not paired with Life.",
                detail: "Inbox and Matters need Life on your Mac.",
                action: ("Pair with Life", { router.sheet = .settings }))
        }
    }
}

/// A calm full-screen message: what is so, in a few words, and the one thing to do about it.
struct Notice: View {
    let title: String
    let detail: String
    var action: (label: String, run: () -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Spacer()
            Text(title).font(.cardHeadline).foregroundStyle(Palette.fg)
            Text(detail).font(.body15).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            if let action {
                Button(action.label, action: action.run).buttonStyle(.pill(.quiet)).padding(.top, 8)
            }
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

/// What was read last, when the latest try failed or Life is out of reach (`since` unknown): the old value stays below.
struct StaleNote: View {
    let since: Date?
    let because: String
    let retry: () async -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "clock.arrow.circlepath").foregroundStyle(Palette.muted).accessibilityHidden(true)
            Text((since.map { "Read at \($0.formatted(.dateTime.hour().minute())). " } ?? "") + because)
                .font(.small).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            QuietChip("Retry", symbol: "arrow.clockwise") { Task { await retry() } }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 2)
        .background(Color.fillTint)
    }
}
