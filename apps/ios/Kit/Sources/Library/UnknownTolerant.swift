/// A server enum (`apps/voice/openapi.json`). A value this app doesn't know yet decodes as `unknown` instead of
/// failing the whole response: one new value must never stop the changes feed. The contract test checks every
/// conformer's cases against the spec.
public protocol UnknownTolerant: RawRepresentable<String>, Decodable, CaseIterable {
    static var unknown: Self { get }
}

extension UnknownTolerant {
    public init(from decoder: any Decoder) throws {
        self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}
