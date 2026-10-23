import SwiftUI

enum MarkResult: Equatable {
    case split(at: Date)
    case splitFailed(String)

    var sentence: String {
        switch self {
        case .split(let at):
            "Split at \(at.formatted(date: .omitted, time: .shortened)) · a new conversation starts here"
        case .splitFailed(let error): "The split wasn't saved: \(error)"
        }
    }
}

/// The floating confirmation after a split, shown only once it is durably saved.
struct MarkToast: View {
    let result: MarkResult

    var body: some View {
        Label {
            Text(result.sentence)
        } icon: {
            Image(systemName: systemImage)
                .foregroundStyle(Palette.redText)
                .accessibilityHidden(true)
        }
        .font(.subheadline.monospacedDigit())
        .foregroundStyle(Palette.textPrimary)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .floatingGlass()
        .padding(.horizontal, 16)
    }

    private var systemImage: String {
        switch result {
        case .split: "scissors"
        case .splitFailed: "exclamationmark.triangle"
        }
    }
}
