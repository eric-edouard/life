import Foundation

/// The matter icon set: each key Life sends (`MATTER_ICONS`, `apps/server/src/records/matter-icon.ts`, the same keys in the
/// same order: `ContractTests` checks) with its SF Symbol, in the grid's nine groups. What the rows, the page and the
/// grid draw.
public enum MatterIcons {
    public struct Icon: Sendable, Hashable {
        public let key: String
        public let symbol: String
    }

    public struct Group: Sendable, Hashable {
        public let label: String
        public let icons: [Icon]

        init(_ label: String, _ icons: KeyValuePairs<String, String>) {
            (self.label, self.icons) = (label, icons.map { Icon(key: $0.key, symbol: $0.value) })
        }
    }

    public static let groups: [Group] = [
        Group(
            "Home and things",
            [
                "home": "house", "key": "key", "sofa": "sofa", "bed": "bed.double", "light": "lightbulb",
                "tools": "wrench.and.screwdriver", "hammer": "hammer", "paint": "paintbrush", "plant": "leaf",
                "water": "drop", "power": "bolt", "box": "shippingbox", "cart": "cart", "bag": "bag", "gift": "gift",
                "clothes": "tshirt",
            ]),
        Group(
            "Money and papers",
            [
                "money": "banknote", "card": "creditcard", "bank": "building.columns", "paper": "doc.text",
                "sign": "signature", "mail": "envelope", "insurance": "shield", "chart": "chart.line.uptrend.xyaxis",
                "id": "person.text.rectangle",
            ]),
        Group(
            "People",
            [
                "person": "person", "people": "person.2", "family": "figure.2.and.child.holdinghands", "heart": "heart",
                "cake": "birthday.cake", "party": "party.popper", "talk": "bubble.left.and.bubble.right",
                "phone": "phone",
            ]),
        Group(
            "Work and learning",
            [
                "work": "briefcase", "laptop": "laptopcomputer", "code": "chevron.left.forwardslash.chevron.right",
                "megaphone": "megaphone", "calendar": "calendar", "clock": "clock", "study": "graduationcap",
                "book": "book", "pencil": "pencil",
            ]),
        Group(
            "Health and body",
            [
                "health": "cross.case", "pills": "pills", "doctor": "stethoscope", "run": "figure.run",
                "gym": "dumbbell", "hair": "scissors", "glasses": "eyeglasses",
            ]),
        Group(
            "Travel and places",
            [
                "plane": "airplane", "car": "car", "train": "tram", "bike": "bicycle", "suitcase": "suitcase",
                "map": "map", "place": "mappin.and.ellipse", "world": "globe", "tent": "tent",
            ]),
        Group("Food and drink", ["food": "fork.knife", "coffee": "cup.and.saucer", "wine": "wineglass"]),
        Group(
            "Devices and media",
            [
                "iphone": "iphone", "wifi": "wifi", "camera": "camera", "tv": "tv", "music": "music.note",
                "game": "gamecontroller", "headphones": "headphones", "printer": "printer",
            ]),
        Group("Other", ["pet": "pawprint", "flag": "flag", "folder": "folder"]),
    ]

    private static let symbols = Dictionary(uniqueKeysWithValues: groups.flatMap(\.icons).map { ($0.key, $0.symbol) })

    /// The SF Symbol of `key`; nil for a key this app does not know (Life may add keys: the area's icon shows).
    public static func symbol(_ key: String) -> String? { symbols[key] }
}
