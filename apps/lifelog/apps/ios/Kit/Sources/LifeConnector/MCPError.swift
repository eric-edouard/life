import Foundation

/// Why a call to Life did not give its answer. Nothing retries inside the client: the caller decides.
public enum MCPError: Error, Equatable, Sendable {
    /// The Mac cannot be reached from here: no internet, host not found or refusing, timed out, connection lost, TLS.
    case unreachable
    /// No pairing, or Life no longer knows it (a refresh refused).
    case notPaired
    /// The pairing code was wrong or expired.
    case wrongCode
    /// Life answered `isError`: the text is why.
    case refused(String)
    /// A 5xx, a JSON-RPC error, an answer that is not what was asked.
    case failed(String)
    /// The stream ended with no result: the call may or may not have run.
    case streamDropped

    /// In words, for a screen.
    public var reason: String {
        switch self {
        case .unreachable: "Your Mac cannot be reached."
        case .notPaired: "This iPhone is not paired with Life."
        case .wrongCode: "That pairing code did not match, or it expired."
        case .refused(let why), .failed(let why): why
        case .streamDropped: "The connection dropped before Life answered."
        }
    }

    /// The error as this module names it: a `URLError` that means "cannot reach", else the error in words.
    public static func of(_ error: any Error) -> MCPError {
        if let known = error as? MCPError { return known }
        guard let url = error as? URLError else { return .failed("\(error)") }
        switch url.code {
        case .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .timedOut, .networkConnectionLost,
            .dnsLookupFailed, .dataNotAllowed, .internationalRoamingOff,
            .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
            .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected,
            .clientCertificateRequired, .cannotLoadFromNetwork:
            return .unreachable
        default: return .failed(url.localizedDescription)
        }
    }
}
