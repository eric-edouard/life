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
    /// No internet from here at all: nothing was sent, and trying again at once cannot help.
    case offline
    /// A call that acts (an answer, a change) got no byte in time: it may have run. Never repeated by itself.
    case timedOut
    /// The stream ended with no result: the call may or may not have run.
    case streamDropped
    /// The task that asked was cancelled (its screen left): not a failure of Life's or of the connection.
    case cancelled

    /// In words, for a screen.
    public var reason: String {
        switch self {
        case .unreachable: "Your Mac cannot be reached."
        case .offline: "This iPhone has no internet connection."
        case .timedOut: "Life did not answer in time. It may not have gone: check before answering again."
        case .notPaired: "This iPhone is not paired with Life."
        case .wrongCode: "That pairing code did not match, or it expired."
        case .refused(let why), .failed(let why): why
        case .streamDropped: "The connection dropped before Life answered."
        case .cancelled: "Cancelled."
        }
    }

    /// The error as this module names it: a `URLError` that means "cannot reach", else the error in words.
    public static func of(_ error: any Error) -> MCPError {
        if let known = error as? MCPError { return known }
        if error is CancellationError { return .cancelled }
        guard let url = error as? URLError else { return .failed("\(error)") }
        switch url.code {
        case .cancelled: return .cancelled
        case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff: return .offline
        case .cannotFindHost, .cannotConnectToHost, .timedOut, .networkConnectionLost,
            .dnsLookupFailed,
            .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
            .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected,
            .clientCertificateRequired, .cannotLoadFromNetwork:
            return .unreachable
        default: return .failed(url.localizedDescription)
        }
    }
}
