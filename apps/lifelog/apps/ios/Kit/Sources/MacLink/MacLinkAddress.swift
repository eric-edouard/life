import Foundation

/// Where the Mac link reaches a Mac (`mac` and `relay` in the pairing link, `MacLinkAddress` in mac-link.ts): the Mac's
/// endpoint id, the public half of its key, and the one relay it keeps its home on. Not secret.
public struct MacLinkAddress: Codable, Hashable, Sendable {
    public let mac: String
    public let relay: String

    public init?(mac: String?, relay: String?) {
        guard let mac, mac.wholeMatch(of: /[A-Za-z0-9]{32,128}/) != nil, let relay,
            URL(string: relay)?.scheme == "https"
        else { return nil }
        (self.mac, self.relay) = (mac, relay)
    }
}

/// A request carries the Mac link it goes over as a property (`MacLinkURLProtocol` reads it): each pairing tags its own
/// requests, so two pairings never share one.
extension URLRequest {
    private static let macLinkKey = "macLink"

    /// The Mac link this request goes over; nil: directly.
    public var macLink: MacLinkAddress? {
        get {
            (URLProtocol.property(forKey: Self.macLinkKey, in: self) as? [String]).flatMap {
                $0.count == 2 ? MacLinkAddress(mac: $0[0], relay: $0[1]) : nil
            }
        }
        set {
            guard let request = (self as NSURLRequest).mutableCopy() as? NSMutableURLRequest else { return }
            if let newValue {
                URLProtocol.setProperty([newValue.mac, newValue.relay], forKey: Self.macLinkKey, in: request)
            } else {
                URLProtocol.removeProperty(forKey: Self.macLinkKey, in: request)
            }
            self = request as URLRequest
        }
    }
}
