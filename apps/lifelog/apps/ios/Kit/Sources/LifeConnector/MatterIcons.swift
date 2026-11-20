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

    /// What a matter with neither an icon nor an area shows.
    public static let fallback = "folder"

    /// The symbol of an area, by its meaning (his areas are his own names); the folder for any other.
    public static func areaSymbol(_ area: String) -> String {
        switch area.lowercased() {
        case "home": "house"
        case "work": "briefcase"
        case "family": "heart"
        case "papers", "admin": "doc"
        case "money": "banknote"
        default: fallback
        }
    }
}

extension MatterRow {
    /// Its icon when this app knows the key: the grid's chosen cell and who chose it. Nil (none, or a key Life added
    /// since) shows the area's icon, unattributed.
    public var knownIcon: Icon? { icon.flatMap { MatterIcons.symbol($0.key) == nil ? nil : $0 } }

    /// What its row and page draw (the chain: his pick, Life's, the first area's icon, the folder; Life sends the first
    /// two as `icon`).
    public var symbol: String {
        icon.flatMap { MatterIcons.symbol($0.key) } ?? areas?.first.map(MatterIcons.areaSymbol)
            ?? MatterIcons.fallback
    }

    /// His own pick, which Undo puts back (nil when the icon is Life's or none), kept even for a key this app lacks.
    public var ownerIconKey: String? { icon?.by == .owner ? icon?.key : nil }
}
