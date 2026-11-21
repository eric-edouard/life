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
    /// Where words go in `text`: the text before them with the space it needs, and the space and text after them. In
    /// place of the caret's selection, kept with the text as it was when the run started, with a space on each side
    /// where a word would otherwise touch; at the end when there is none, the text changed since (byte for byte) or the
    /// selection no longer fits it (the field's caret outlives text its code replaced: Send's emptying leaves a range
    /// past the new end). The landing and the live words while he speaks share it.
    public static func parts(
        in text: String, at caret: (text: String, selection: Range<String.Index>?)?
    ) -> (head: String, tail: String) {
        let kept = caret.flatMap { $0.text.utf8.elementsEqual(text.utf8) ? $0.selection : nil }.flatMap { range in
            String.Index(range.lowerBound, within: text).flatMap { lower in
                String.Index(range.upperBound, within: text).map { lower..<$0 }
            }
        }
        let range = kept ?? text.endIndex..<text.endIndex
        let before = text[..<range.lowerBound]
        let after = text[range.upperBound...]
        let lead = before.last.map { $0.isWhitespace ? "" : " " } ?? ""
        let trail = after.first.map { $0.isWhitespace || $0.isPunctuation ? "" : " " } ?? ""
        return (String(before) + lead, trail + after)
    }

    /// `words` at the caret (`parts`): the text and where the caret goes, after the words; nil for none.
    public static func inserting(
        _ words: String, into text: String, at caret: (text: String, selection: Range<String.Index>?)?
    ) -> (text: String, caret: String.Index)? {
        let words = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return nil }
        let (head, tail) = parts(in: text, at: caret)
        let result = head + words + tail
        return (result, result.index(result.startIndex, offsetBy: (head + words).count))
    }
}
