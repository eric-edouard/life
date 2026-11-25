import Foundation

// The main session's wire (`records/main-session-wire.ts`): what the phone sends it and the lines and answer it gets back.

/// What is on his screen, as refs only: never text or pixels.
public struct MainSessionScreen: Encodable, Sendable, Equatable {
    public var open: String?
    public var tab: String?
    public var visible: [String]?

    public init(open: String? = nil, tab: String? = nil, visible: [String]? = nil) {
        (self.open, self.tab, self.visible) = (open, tab, visible)
    }
}

/// One call to `ask_main_session`: his words, or his Stop, or his reaction to one of Life's entries, or (none of them)
/// his presence on the screen.
public struct MainSessionRequest: Encodable, Sendable, Equatable {
    public struct Reaction: Encodable, Sendable, Equatable {
        public let entry: Int
        public let with: String
    }
    /// The version of Life's blocks this phone draws (`BLOCK_KINDS` in `AnswerBlocks.swift`).
    public var catalog: Int?
    public var react: Reaction?
    public var screen: MainSessionScreen?
    public var stop: Bool?
    public var words: String?

    public static func ask(_ words: String, screen: MainSessionScreen) -> Self {
        Self(catalog: LifeBlock.catalog, screen: screen, words: words)
    }
    public static let stop = Self(stop: true)
    public static func react(entry: Int, with: String) -> Self { Self(react: Reaction(entry: entry, with: with)) }
    public static let present = Self()
}

/// A line the session streams before its answer. A `step` after words starts the answer again (it is the text after the
/// last tool call), so the blocks and words so far are dropped.
enum MainSessionLine: Equatable {
    case thinking
    case step(verb: String, what: String)
    case words(String)
    case block(LifeBlock)
    case reaction(String)

    init?(_ data: Data) {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let kind = o["kind"] as? String
        else { return nil }
        switch kind {
        case "thinking": self = .thinking
        case "step": self = .step(verb: o["verb"] as? String ?? "", what: o["what"] as? String ?? "")
        case "words": guard let text = o["text"] as? String else { return nil }; self = .words(text)
        case "reaction": guard let with = o["with"] as? String else { return nil }; self = .reaction(with)
        case "block":
            guard let type = o["type"] as? String, let body = o["block"],
                JSONSerialization.isValidJSONObject(body) || body is String,
                let json = try? JSONSerialization.data(withJSONObject: body),
                let block = LifeBlock(kind: type, json: json)
            else { return nil }
            self = .block(block)
        default: return nil
        }
    }
}

/// The call's end: Life's thread entry and Markdown, or why it failed.
enum MainSessionResult: Equatable {
    case reply(entry: Int, text: String, refs: [String], reaction: String?)
    case error(what: String, entry: Int?)

    init(_ text: String) {
        let o = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
        if o["kind"] as? String == "reply", let entry = o["entry"] as? Int {
            self = .reply(
                entry: entry, text: o["text"] as? String ?? "", refs: o["refs"] as? [String] ?? [],
                reaction: o["reaction"] as? String)
        } else {
            self = .error(what: o["what"] as? String ?? "Life did not say why.", entry: o["entry"] as? Int)
        }
    }
}
