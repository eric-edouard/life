import Foundation

/// Why a field's dictation brought no words: `notReached`, nothing reached the server's paid step (the route itself said
/// `identity_busy`, or the request never left the phone), so the same recording may go again; `notWritten`, it may have been heard and the
/// answer lost, or its words aren't whole, so the owner says it again and the same bytes never go twice.
public enum DictationFailure: Error, Equatable {
    case notReached, notWritten

    /// The one rule for what failed.
    public init(_ error: any Error) {
        switch error {
        case ServerClient.ClientError.notPaired, ServerClient.ClientError.server(status: 503, "identity_busy", _):
            self = .notReached
        case let error as URLError
        where [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed].contains(error.code):
            self = .notReached
        default: self = .notWritten
        }
    }
}

extension ServerClient {
    /// The words of one run of a field's dictation (Ogg Opus), heard ahead of all other work. Sent once: see
    /// `DictationFailure` for when the same bytes may go again.
    public func dictationWords(_ ogg: Data) async throws -> String {
        struct Words: Decodable { var text: String }
        return try decode(Words.self, try await send(try dictationRequest(), body: ogg)).text
    }

    /// Its request. The server may wait 60 s for a Scribe slot, then hear up to 10 minutes of audio: the phone waits
    /// longer than that, so a queued answer isn't lost to its own timeout.
    func dictationRequest() throws -> URLRequest {
        var request = try request("dictation/transcript", method: "POST")
        request.setValue("audio/ogg", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 300
        return request
    }
}

/// Dictated words put into a field's text where the caret is, as typing would.
public enum DictatedText {
    /// `words` in place of `selection` (the end when there is none), with a space on each side where a word would
    /// otherwise touch; the text and where the caret goes, after the words.
    public static func inserting(
        _ words: String, into text: String, at selection: Range<String.Index>?
    ) -> (text: String, caret: String.Index) {
        let words = words.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = selection ?? text.endIndex..<text.endIndex
        guard !words.isEmpty else { return (text, range.upperBound) }
        let before = text[..<range.lowerBound]
        let after = text[range.upperBound...]
        let lead = before.last.map { $0.isWhitespace ? "" : " " } ?? ""
        let trail = after.first.map { $0.isWhitespace || $0.isPunctuation ? "" : " " } ?? ""
        let head = String(before) + lead + words
        let result = head + trail + after
        return (result, result.index(result.startIndex, offsetBy: head.count))
    }
}
