import SwiftUI

/// SF stays the UI face (`.body`, `.subheadline`, …). Newsreader carries conversation titles and quotes, Geist Mono
/// carries times and durations. Both bundled faces are variable fonts registered in Info.plist (`UIAppFonts`), and
/// every size here scales with Dynamic Type through its text style.
extension Font {
    /// The conversation title at the top of the reader.
    static let readerTitle = serif(30, relativeTo: .title).weight(.medium)
    /// An empty state's title, a person's name.
    static let cardTitle = serif(21, relativeTo: .title2).weight(.medium)
    /// A conversation title in the library.
    static let rowTitle = serif(19, relativeTo: .title3).weight(.medium)
    /// A title that is still a placeholder ("Conversation at 13:52"); pair with `Palette.textBody`.
    static let placeholderTitle = serif(17, relativeTo: .body).italic()

    /// The Pendant's state in one word on the Pendant screen: "Recording."
    static let statusWord = serif(54, relativeTo: .largeTitle)
    /// A longer status sentence ("Bluetooth is off."); italic while waiting ("Waiting for Pendant…").
    static let statusSentence = serif(36, relativeTo: .title)
    /// Words someone said, to read before hearing them: a clip of a voice to name.
    static let spokenQuote = serif(18, relativeTo: .body)

    /// A figure at a glance: "82 %", "340 pg".
    static let monoFigure = mono(22, relativeTo: .title2).weight(.medium)
    /// A start time in a row.
    static let monoTime = mono(13, relativeTo: .footnote)
    /// Durations and counts beside other metadata.
    static let monoDetail = mono(12, relativeTo: .caption)
    /// Playback positions and transcript timestamps.
    static let monoSmall = mono(11, relativeTo: .caption2)

    private static func serif(_ size: CGFloat, relativeTo style: TextStyle) -> Font {
        .custom("Newsreader", size: size, relativeTo: style)
    }

    private static func mono(_ size: CGFloat, relativeTo style: TextStyle) -> Font {
        .custom("Geist Mono", size: size, relativeTo: style).monospacedDigit()
    }
}
