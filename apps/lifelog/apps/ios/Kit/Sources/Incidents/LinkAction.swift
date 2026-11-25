import Foundation

/// What a link opened in the app does: a pairing link is asked, `lifelog://open?ref=` opens a `life:` ref, anything
/// else, or a pairing link while one is in flight (one pairing at a time), does nothing.
public enum LinkAction: Equatable, Sendable {
    case pair
    case open(String)
    case ignore

    /// `isPairLink`: the link names a server or a Life to pair with (the app parses it); `isPairing`: a pairing is
    /// being checked now.
    public init(url: URL, isPairLink: Bool, isPairing: Bool) {
        if isPairLink {
            self = isPairing ? .ignore : .pair
        } else if url.host == "open",
            let ref = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
                .first(where: { $0.name == "ref" })?.value, !ref.isEmpty
        {
            self = .open(ref)
        } else {
            self = .ignore
        }
    }
}
