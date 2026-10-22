import SwiftUI

/// A status: a dot in its colour that breathes while work runs, the word beside it in mono, in ink.
struct Pill: View {
  let tone: Tone
  let word: String
  @Environment(\.accessibilityReduceMotion) private var still
  @State private var dim = false

  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(tone.color).frame(width: 8, height: 8)
        .opacity(dim ? 0.35 : 1)
      Text(word).font(Brand.mono(11, .medium)).lineLimit(1)
    }
    .foregroundStyle(Brand.ink)
    .fixedSize()
    .onAppear {
      guard tone == .busy, !still else { return }
      withAnimation(.easeInOut(duration: 1.2).repeatForever()) { dim = true }
    }
  }
}

/// "3 h ago", "in 2 h": an instant as the plate's facts show it.
func ago(_ at: Date) -> String {
  at.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
}
