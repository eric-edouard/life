import Foundation

/// One press, "Quick question to AI": the last minute's words, with a short instruction, filled into Claude or ChatGPT.
/// The links are universal links listed in each app's association file, so they open the app, which fills the text in
/// (the owner's test, Oct 15).
public enum QuickQuestion {
    public enum App: String, Sendable, CaseIterable {
        case claude, chatgpt

        public var name: String { self == .claude ? "Claude" : "ChatGPT" }
        /// The app with an empty question, for text over the cap (it goes through the clipboard).
        public var home: URL? {
            URL(string: self == .claude ? "https://claude.ai/new" : "https://chatgpt.com/")
        }
    }

    /// Longer than this once encoded and the link isn't used: the text goes through the clipboard.
    static let maximumEncodedBytes = 6_000

    public static func prompt(_ transcript: String) -> String {
        "Below is a transcript of the last minute around me. Ignore unrelated speech and context, and answer what I "
            + "ask at the end:\n\n\(transcript)"
    }

    /// The link that opens `app` with `text` filled in; `nil` when it would be too long.
    public static func link(_ app: App, text: String) -> URL? {
        guard let home = app.home else { return nil }
        var components = URLComponents(url: home, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "q", value: text)]
        guard let url = components?.url, url.absoluteString.utf8.count <= maximumEncodedBytes else { return nil }
        return url
    }
}

extension ServerClient {
    /// The words of a press's audio, from ElevenLabs through the server (`POST /quick-transcriptions`).
    public struct QuickTranscript: Sendable, Decodable, Equatable {
        public var text: String
    }

    /// Transcribes `audio` (Ogg Opus) at once. Nothing is kept on the server but its cost. Refused while transcription
    /// is off (409 `transcription_off`).
    public func quickTranscription(audio: URL) async throws -> QuickTranscript {
        try decode(
            QuickTranscript.self,
            try await upload(audio: audio, to: try request("quick-transcriptions", method: "POST")))
    }
}
