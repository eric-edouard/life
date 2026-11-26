/// The matter icon set: each key Life sends (`MATTER_ICONS`, `apps/server/src/records/matter-icon.ts`) with its SF Symbol.
public enum MatterIcons {
    private static let symbols: [String: String] = [
        "home": "house", "key": "key", "sofa": "sofa", "bed": "bed.double", "light": "lightbulb",
        "tools": "wrench.and.screwdriver", "hammer": "hammer", "paint": "paintbrush", "plant": "leaf",
        "water": "drop", "power": "bolt", "box": "shippingbox", "cart": "cart", "bag": "bag", "gift": "gift",
        "clothes": "tshirt", "money": "banknote", "card": "creditcard", "bank": "building.columns",
        "paper": "doc.text", "sign": "signature", "mail": "envelope", "insurance": "shield",
        "chart": "chart.line.uptrend.xyaxis", "id": "person.text.rectangle", "person": "person",
        "people": "person.2", "family": "figure.2.and.child.holdinghands", "heart": "heart",
        "cake": "birthday.cake", "party": "party.popper", "talk": "bubble.left.and.bubble.right",
        "phone": "phone", "work": "briefcase", "laptop": "laptopcomputer",
        "code": "chevron.left.forwardslash.chevron.right", "megaphone": "megaphone", "calendar": "calendar",
        "clock": "clock", "study": "graduationcap", "book": "book", "pencil": "pencil", "health": "cross.case",
        "pills": "pills", "doctor": "stethoscope", "run": "figure.run", "gym": "dumbbell", "hair": "scissors",
        "glasses": "eyeglasses", "plane": "airplane", "car": "car", "train": "tram", "bike": "bicycle",
        "suitcase": "suitcase", "map": "map", "place": "mappin.and.ellipse", "world": "globe", "tent": "tent",
        "food": "fork.knife", "coffee": "cup.and.saucer", "wine": "wineglass", "iphone": "iphone", "wifi": "wifi",
        "camera": "camera", "tv": "tv", "music": "music.note", "game": "gamecontroller",
        "headphones": "headphones", "printer": "printer", "pet": "pawprint", "flag": "flag", "folder": "folder",
    ]

    /// The SF Symbol of `key`; nil for a key this app does not know (Life may add keys).
    public static func symbol(_ key: String) -> String? { symbols[key] }
}
