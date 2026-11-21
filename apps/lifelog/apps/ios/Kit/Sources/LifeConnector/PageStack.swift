/// A tab's page on show, by ref, and what is pushed on it. Opening a page, even the one on show, starts it bare: what
/// was pushed on it before is gone.
public struct PageStack<Route: Hashable>: Equatable {
    public private(set) var page: String?
    public var path: [Route] = []

    public init() {}

    public mutating func open(_ ref: String?) { (page, path) = (ref, []) }
}
