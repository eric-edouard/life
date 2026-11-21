import SwiftUI

/// How Tell Life draws an answer (decision 91): the lit line over the words (the default), or the words alone in Grotesk
/// with their key words in bold.
enum TellLook: String, CaseIterable {
    case lit, grotesk
    static let key = "tellLook"
    var title: String { self == .lit ? "Lit line" : "Grotesk" }
}

/// Settings, Tell Life: its look. (Where his words are heard is Settings' Dictation, for every field.)
struct TellSettingsPage: View {
    @AppStorage(TellLook.key) private var look = TellLook.lit

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                RowGroup(label: "Look", surface: .sheet) {
                    SegmentedChoice(
                        choices: TellLook.allCases, selection: Binding(get: { look }, set: { look = $0 ?? look }),
                        title: \.title
                    )
                    .padding(Metrics.Spacing.s)
                }
            }
            .padding(.horizontal, Metrics.gutter).padding(.top, Metrics.Spacing.l).readingWidth()
        }
        .background(Palette.sheet)
        .navigationTitle("Tell Life")
    }
}
