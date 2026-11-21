import Foundation

/// A part read page by page (someone's `reach`, their `latest` paging back), as it stands: the pages that arrived, in
/// order from the first, and what comes after them. A page is asked for only once the one before it arrived, so each
/// shows once; one that failed stays the next to ask for, so Retry reads it again.
public struct PageChain<Page: Sendable> {
    public enum Next: Equatable, Sendable {
        /// The page to ask for next, not asked yet.
        case more(String)
        case reading(String)
        /// Asked and not read: asking again retries it.
        case failed(String)
        case end
    }

    public let pages: [Page]
    public let next: Next

    /// The chain from `first` over the pages read so far, by ref; `nextOf` gives a page's next ref (none: the last).
    public init(from first: String, states: [String: ReadState<Page>], next nextOf: (Page) -> String?) {
        var pages: [Page] = []
        var ref: String? = first
        var seen: Set<String> = []
        var next = Next.end
        // A ref seen twice ends the chain: a page that names itself as next would never end.
        while let at = ref, seen.insert(at).inserted {
            guard let page = states[at]?.value else {
                let state = states[at]
                next = state?.hasFailed == true ? .failed(at) : state?.phase == .loading ? .reading(at) : .more(at)
                break
            }
            pages.append(page)
            ref = nextOf(page)
        }
        (self.pages, self.next) = (pages, next)
    }

    /// The page to read now: the next one, or the one that failed.
    public var toRead: String? {
        switch next {
        case .more(let ref), .failed(let ref): ref
        case .reading, .end: nil
        }
    }

    /// The next page was asked and not read: asking again retries it.
    public var isFailed: Bool {
        if case .failed = next { true } else { false }
    }

    /// Every page, once the last arrived; nil while some are still to read.
    public var whole: [Page]? { next == .end ? pages : nil }
}
