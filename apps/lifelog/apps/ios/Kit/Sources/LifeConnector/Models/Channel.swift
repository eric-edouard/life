/// A chat's network as he knows it ("WhatsApp", "iMessage"), from the source Life names it by; "The chat" when none.
public enum Channel {
    public static func name(_ source: String?) -> String {
        switch source {
        case "whatsapp": "WhatsApp"
        case "imessage": "iMessage"
        case "messenger": "Messenger"
        case "instagram": "Instagram"
        case "linkedin": "LinkedIn"
        case "telegram": "Telegram"
        case "line": "LINE"
        case "gmail", "mail": "Mail"
        case let other?: other.capitalized
        case nil: "The chat"
        }
    }
}
