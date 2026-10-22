import SwiftUI

/// Ledger's status chip: a tinted ground, the word in mono, a dot that breathes while work runs.
struct Pill: View {
  let tone: Tone
  let word: String
  @Environment(\.accessibilityReduceMotion) private var still
  @State private var dim = false

  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(tone.color).frame(width: 6, height: 6)
        .opacity(dim ? 0.35 : 1)
      Text(word).font(Ledger.mono(10.5, .medium)).lineLimit(1)
    }
    .foregroundStyle(tone.color)
    .padding(.horizontal, 7)
    .padding(.vertical, 4)
    .background(tone.color.opacity(0.13), in: .rect(cornerRadius: 4))
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
