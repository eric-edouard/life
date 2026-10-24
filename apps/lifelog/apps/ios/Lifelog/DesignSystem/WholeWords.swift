import SwiftUI

/// Text that wraps between words and never inside one. At the largest text sizes a plain `Text` hyphenates a word
/// wider than the line ("Recordi-ng."); here such a word shrinks to fit its line instead. Reads as one element.
struct WholeWords: View {
    let text: String
    var centered = false

    init(_ text: String, centered: Bool = false) {
        self.text = text
        self.centered = centered
    }

    var body: some View {
        let words = text.split(separator: " ")
        FlowLayout(centered: centered) {
            // A word's position is its identity: the text is fixed for the view's life. No space after the last word,
            // so a centered line is centered on its letters.
            ForEach(Array(words.enumerated()), id: \.offset) { index, word in
                Text(index < words.count - 1 ? word + " " : String(word))
                    .lineLimit(1)
                    .minimumScaleFactor(0.3)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
    }
}
