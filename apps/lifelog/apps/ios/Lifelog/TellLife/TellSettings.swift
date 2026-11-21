import SwiftUI

/// How Tell Life draws an answer (decision 91): the lit line over the words (the default), or the words alone in Grotesk
/// with their key words in bold.
enum TellLook: String, CaseIterable {
    case lit, grotesk
    static let key = "tellLook"
    var title: String { self == .lit ? "Lit line" : "Grotesk" }
}

/// Where his words are heard as he speaks: live by ElevenLabs, or on his Mac after he stops. The choice is kept here;
/// live words arrive with their own change.
enum TellWords: String, CaseIterable {
    case live, mac
    static let key = "tellWords"
    var title: String { self == .live ? "Live" : "On your Mac" }
}

/// Settings, Tell Life: the two choices, in his words.
struct TellSettingsPage: View {
    @AppStorage(TellLook.key) private var look = TellLook.lit
    @AppStorage(TellWords.key) private var words = TellWords.live

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                RowGroup(label: "Look", surface: .sheet) {
                    SegmentedChoice(
                        choices: TellLook.allCases, selection: Binding(get: { look }, set: { look = $0 ?? look }),
                        title: \.title
                    )
                    .padding(8)
                }
                RowGroup(label: "Your words, as you speak", surface: .sheet) {
                    SegmentedChoice(
                        choices: TellWords.allCases, selection: Binding(get: { words }, set: { words = $0 ?? words }),
                        title: \.title
                    )
                    .padding(8)
                }
            }
            .padding(.horizontal, Metrics.gutter).padding(.top, 16).readingWidth()
        }
        .background(Palette.sheet)
        .navigationTitle("Tell Life")
    }
}
