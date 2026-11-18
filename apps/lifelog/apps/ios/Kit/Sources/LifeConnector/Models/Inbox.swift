import Foundation

/// `read_inbox`: every check, most urgent first, with the counts the badge and the tabs show.
public struct Inbox: Decodable, Sendable, Equatable {
    public let checks: [Check]
    public let counts: [String: Int]
    public let total: Int
    public let deadlinesToday: Int
}
