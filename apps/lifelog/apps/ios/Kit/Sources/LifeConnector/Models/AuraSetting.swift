import Foundation

/// The edge's look: every value the phone's edge uses (`EdgeView`), as his halo settings tune it and Life keeps it (the
/// `aura` setting, `core/settings.ts`'s `Aura`, the source of truth for its keys and ranges). `standard` is today's look.
public struct AuraSetting: Codable, Equatable, Sendable {
    /// A turning light: how strong, how fast and which way, and where its bright part peaks and ends (0–1 of a turn).
    public struct Light: Codable, Equatable, Sendable {
        public var clockwise: Bool
        public var end: Double
        /// How much brighter than the state's brightness its bright part is.
        public var gain: Double
        public var opacity: Double
        public var peak: Double
        /// One turn at speed 1.
        public var seconds: Double
    }
    /// The edge in one state.
    public struct State: Codable, Equatable, Sendable {
        public var blur, brightness, colour, glow, lights, pool, speed: Double
    }
    public struct Line: Codable, Equatable, Sendable {
        public var opacity, width: Double
    }
    public struct Rings: Codable, Equatable, Sendable {
        public var calm, work: Double
    }
    public struct States: Codable, Equatable, Sendable {
        public var rest, speaking, still, working: State
    }

    /// The working arc.
    public var arc: Light
    /// One of the aura's ten colours, by its place: Life blue, cream, then `Palette.auraColours`.
    public var colour: Int
    public var glowOpacity: Double
    /// The two lights that turn at rest and while he speaks.
    public var lights: [Light]
    /// The fine border; width 0 is none.
    public var line: Line
    public var poolRadius: Double
    public var rings: Rings
    public var states: States

    /// Today's look: two soft lights turning opposite ways over a faint cream ring, faster while he speaks with a pool
    /// of light by the field, a blue swell and arc while Life works, still and dimmer with no Mac.
    public static let standard = AuraSetting(
        arc: Light(clockwise: true, end: 0.38, gain: 1, opacity: 0.6, peak: 0.17, seconds: 5),
        colour: 0, glowOpacity: 0.7,
        lights: [
            Light(clockwise: true, end: 0.33, gain: 2.8, opacity: 0.6, peak: 0.15, seconds: 18),
            Light(clockwise: false, end: 0.33, gain: 2.2, opacity: 0.6, peak: 0.15, seconds: 27),
        ],
        line: Line(opacity: 1, width: 1), poolRadius: 220, rings: Rings(calm: 0.4, work: 0.5),
        states: States(
            rest: State(blur: 9.5, brightness: 0.35, colour: 0, glow: 9.5, lights: 0.9, pool: 0, speed: 1),
            speaking: State(blur: 16, brightness: 0.5, colour: 0, glow: 16, lights: 1, pool: 0.2625, speed: 1.825),
            still: State(blur: 9.5, brightness: 0.175, colour: 0, glow: 9.5, lights: 0.9, pool: 0, speed: 0),
            working: State(blur: 22, brightness: 0.93, colour: 1, glow: 22, lights: 0, pool: 0, speed: 2)))

    /// The aura `change_setting` answered with (`{aura, budget}`); nil when it holds none.
    public static func saved(in answer: String) -> AuraSetting? {
        struct Answer: Decodable { let aura: AuraSetting? }
        return (try? JSONDecoder().decode(Answer.self, from: Data(answer.utf8)))?.aura
    }
}
