import Foundation

/// A tapped push's own read: that one card (`read_inbox` by `pushId`), shown until the whole inbox is read.
public struct PushRead: Sendable {
    public let id: String
    public internal(set) var state = ReadState<Inbox>()

    public init(id: String) { self.id = id }
}

extension PushRead? {
    /// An event of the read for `id`; ignored once a later push replaced it or the whole inbox read cleared it.
    public mutating func apply(_ event: ReadState<Inbox>.Event, id: String) {
        guard self?.id == id else { return }
        self?.state.apply(event)
    }
}
