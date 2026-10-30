import SwiftUI

/// The last 24 hours (the status snapshot's `today`): runs as bars in their colour, emails and failures as marks, the Mac's
/// sleeps as a muted band, and now at the right edge.
struct DayStrip: View {
  let ticks: [Tick]
  let now: Date
  var height: CGFloat = 40

  private var from: Date { now.addingTimeInterval(-86_400) }

  var body: some View {
    VStack(spacing: 6) {
      GeometryReader { geo in
        let x = { (at: Date) in max(0, min(1, at.timeIntervalSince(from) / 86_400)) * geo.size.width }
        ZStack(alignment: .leading) {
          ForEach(ticks, id: \.self) { t in
            if t.sleep == true {
              Rectangle().fill(Brand.rule)
                .frame(width: max(2, x(t.end ?? now) - x(t.at)))
                .offset(x: x(t.at))
            } else if t.end != nil {
              RoundedRectangle(cornerRadius: 3).fill(t.tone.color)
                .frame(width: max(3, x(t.end ?? now) - x(t.at)), height: height * 0.36)
                .offset(x: x(t.at))
            } else {
              Rectangle().fill(t.tone.color)
                .frame(width: 2, height: height * 0.64)
                .offset(x: x(t.at))
            }
          }
          Rectangle().fill(Brand.ink).frame(width: 2)
            .offset(x: geo.size.width - 2)
        }
        .frame(maxHeight: .infinity)
      }
      .frame(height: height)
      .background(Brand.card, in: .rect(cornerRadius: Brand.control))
      .clipShape(.rect(cornerRadius: Brand.control))
      .accessibilityElement()
      .accessibilityLabel("The last 24 hours: \(ticks.filter { $0.sleep != true }.count) runs and emails")

      HStack {
        ForEach(0..<8, id: \.self) { i in
          Text(from.addingTimeInterval(Double(i) * 3 * 3_600), format: .dateTime.hour(.twoDigits(amPM: .omitted)))
          Spacer()
        }
        Text("now").foregroundStyle(Brand.ink)
      }
      .font(Brand.mono(10.5))
      .foregroundStyle(Brand.muted)
    }
  }
}
