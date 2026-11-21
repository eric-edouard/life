import SwiftUI

/// A network's mark (`net_mark`, `net_logo`): the app's own mark in its own colour (`Marks.xcassets`, `network.<app>`;
/// mail through Gmail takes Gmail's), never a bubble in a brand colour; a network with none of its own (the phone, one
/// this build doesn't know) keeps its line glyph in `muted`. 16 on its own.
struct NetworkMark: View {
    let network: String?
    var size: CGFloat = 16

    private static let ownMarks: Set = [
        "whatsapp", "imessage", "messenger", "instagram", "linkedin", "telegram", "line",
    ]

    var body: some View {
        Group {
            if let asset {
                Image(asset).resizable().scaledToFit()
            } else if network == "contacts" {
                // His Contacts card: the person-in-a-card glyph.
                Image(systemName: "person.text.rectangle").resizable().scaledToFit().foregroundStyle(Palette.fg)
            } else {
                Image(systemName: network == "phone" ? "phone" : "bubble.left").resizable().scaledToFit()
                    .foregroundStyle(Palette.muted)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var asset: String? {
        switch network {
        case "gmail", "mail": "network.gmail"
        case let app? where Self.ownMarks.contains(app): "network.\(app)"
        default: nil
        }
    }
}
