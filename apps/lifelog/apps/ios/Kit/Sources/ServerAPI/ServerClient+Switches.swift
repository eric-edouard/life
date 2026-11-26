import Foundation
import Library

extension ServerClient {
    /// The owner's switches for paid processing (openapi `Switches`), also set with `bun run switches`. Off, that
    /// work waits and goes on once it is back on. `openAppAfterMinutes` is not one of them: it is when the server asks
    /// him to open the app, set the same way.
    public struct Switches: Sendable, Codable, Equatable {
        /// Audio to ElevenLabs and voices to speaker recognition.
        public var transcription: Bool
        /// Summaries and titles on the Mac, off by default. Search doesn't depend on it.
        public var ai: Bool
        public enum Engine: String, Sendable, Codable, UnknownTolerant { case claude, codex, unknown }
        public var engine: Engine
        /// Minutes the Pendant's audio may wait on the phone, while it records, before a notification asks him to open
        /// the app; 0 is never.
        public var openAppAfterMinutes: Int
        /// Where a field's dictation is heard: on the Mac after each pause (the default), or instantly by ElevenLabs'
        /// realtime Scribe as he speaks (`LiveWords`), whose token the Mac mints only then.
        public enum DictationHeard: String, Sendable, Codable, UnknownTolerant { case mac, instant, unknown }
        public var dictationHeard: DictationHeard

        public init(
            transcription: Bool, ai: Bool, engine: Engine = .claude, openAppAfterMinutes: Int,
            dictationHeard: DictationHeard = .instant
        ) {
            self.transcription = transcription
            self.ai = ai
            self.engine = engine
            self.openAppAfterMinutes = openAppAfterMinutes
            self.dictationHeard = dictationHeard
        }

        private enum CodingKeys: String, CodingKey {
            case transcription, ai, engine, openAppAfterMinutes, dictationHeard
        }

        public init(from decoder: any Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            transcription = try values.decode(Bool.self, forKey: .transcription)
            ai = try values.decode(Bool.self, forKey: .ai)
            engine = try values.decodeIfPresent(Engine.self, forKey: .engine) ?? .claude
            openAppAfterMinutes = try values.decode(Int.self, forKey: .openAppAfterMinutes)
            dictationHeard = try values.decodeIfPresent(DictationHeard.self, forKey: .dictationHeard) ?? .mac
        }

    }
}
