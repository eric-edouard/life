import SwiftUI

enum DayTitle {
    /// "Today", "Yesterday", else "Oct 11" (with the year when it isn't this year).
    static func short(_ day: Date, calendar: Calendar = .current, now: Date = .now) -> String {
        let (title, detail) = parts(day, calendar: calendar, now: now)
        return title == "Today" || title == "Yesterday" ? title : detail
    }

    /// "Today" or "Yesterday" with the short date, else the weekday with the date (and the year when it isn't this
    /// year).
    static func parts(_ day: Date, calendar: Calendar = .current, now: Date = .now) -> (title: String, detail: String) {
        let short = Date.FormatStyle.dateTime.weekday(.abbreviated).day().month(.abbreviated)
        if calendar.isDate(day, inSameDayAs: now) { return ("Today", day.formatted(short)) }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
            calendar.isDate(day, inSameDayAs: yesterday)
        {
            return ("Yesterday", day.formatted(short))
        }
        let date = Date.FormatStyle.dateTime.day().month(.abbreviated)
        let detail =
            calendar.isDate(day, equalTo: now, toGranularity: .year) ? day.formatted(date) : day.formatted(date.year())
        return (day.formatted(.dateTime.weekday(.wide)), detail)
    }
}

struct DateJumpSheet: View {
    let jump: (Date) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var day = Date.now

    var body: some View {
        NavigationStack {
            ScrollView {
                DatePicker("Day", selection: $day, in: ...Date.now, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .tint(Palette.redText)
                    .padding(.horizontal, Metrics.gutter)
            }
            .navigationTitle("Go to date")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Go", systemImage: "checkmark") {
                        jump(day)
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
