import SwiftUI

/// A run opened from a history: its steps with their outcome, time and counts, and what it wrote.
struct RunSteps: View {
  let id: String
  let status: Status
  @State private var run: RunView?
  @State private var missing = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let run {
        if let use = run.use { Text("Spent: \(use)").font(Ledger.mono(11)).foregroundStyle(Ledger.muted) }
        ForEach(run.steps) { s in
          HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle().fill(s.tone.color).frame(width: 6, height: 6)
            Text(s.step).font(Ledger.serif(13))
            Spacer()
            Text([s.result?.text, s.use, minutes(s)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
              .font(Ledger.mono(11)).foregroundStyle(Ledger.muted).lineLimit(1)
          }
        }
        Text(wrote(run)).font(Ledger.mono(11)).foregroundStyle(Ledger.muted).padding(.top, 4)
      } else {
        Text(missing ? "Gone from the log" : "Reading…").foregroundStyle(Ledger.muted)
      }
    }
    .padding(.vertical, 4)
    .task(id: id) {
      run = await status.run(id)
      missing = run == nil
    }
  }

  private func minutes(_ s: RunView.Step) -> String? {
    guard let a = s.startedAt, let b = s.endedAt else { return nil }
    return "\(max(1, Int(b.timeIntervalSince(a) / 60))) min"
  }

  private func wrote(_ run: RunView) -> String {
    let parts = run.wrote.byType.sorted { $0.key < $1.key }.map { "\($0.value) \($0.key)" }
    return parts.isEmpty ? "Wrote nothing" : "Wrote " + parts.joined(separator: " · ")
  }
}
