import Foundation
import Library

extension ServerClient {
    /// The owner's switches for paid processing (openapi `Switches`), also set with `bun run switches`. Off, that
    /// work waits and goes on once it is back on. `openAppAfterMinutes` is not one of them: it is when the server asks
    /// him to open the app, set the same way.
    public struct Switches: Sendable, Codable, Equatable {
        /// Audio to ElevenLabs and voices to speaker recognition.
        public var transcription: Bool
        /// Summaries and titles on the Mac, and search by meaning.
        public var ai: Bool
        public enum Engine: String, Sendable, Codable, UnknownTolerant { case claude, codex, unknown }
        public var engine: Engine
        /// Minutes the Pendant's audio may wait on the phone, while it records, before a notification asks him to open
        /// the app; 0 is never.
        public var openAppAfterMinutes: Int

        public init(transcription: Bool, ai: Bool, engine: Engine = .claude, openAppAfterMinutes: Int) {
            self.transcription = transcription
            self.ai = ai
            self.engine = engine
            self.openAppAfterMinutes = openAppAfterMinutes
        }

        private enum CodingKeys: String, CodingKey { case transcription, ai, engine, openAppAfterMinutes }

        public init(from decoder: any Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            transcription = try values.decode(Bool.self, forKey: .transcription)
            ai = try values.decode(Bool.self, forKey: .ai)
            engine = try values.decodeIfPresent(Engine.self, forKey: .engine) ?? .claude
            openAppAfterMinutes = try values.decode(Int.self, forKey: .openAppAfterMinutes)
        }

    }
}
