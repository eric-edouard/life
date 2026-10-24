import Foundation
import Library
import Timeline

/// The text exporters. Pure functions of a `ConversationExport`; output is UTF-8 with `\n` line ends.
extension ConversationExport {
    public func plainText() -> String {
        var out = "\(title)\n\(when)\n\n"
        if let absent = absentTranscript { return out + absent + "\n" }
        for turn in turns {
            out += "[\(clock(turn.start))] \(turn.speaker.displayName): \(turn.text)\n"
        }
        return out
    }

    public func markdown() -> String {
        var out = "# \(title)\n\n- When: \(when)\n"
        if let place = conversation.place { out += "- Place: \(place)\n" }
        if let tldr = conversation.tldr, !tldr.isEmpty { out += "\n> \(tldr)\n" }
        let titled = chapters.compactMap { chapter in chapter.title.map { (chapter.start, $0) } }
        if !titled.isEmpty {
            out += "\n## Chapters\n\n" + titled.map { "- \(clock($0.0)) \($0.1)\n" }.joined()
        }
        out += "\n## Transcript\n\n"
        if let absent = absentTranscript { return out + "_\(absent)_\n" }
        return out
            + turns.map { "**\($0.speaker.displayName)** · \(clock($0.start))\\\n\($0.text)\n" }.joined(separator: "\n")
    }

    /// SubRip captions, timed from the start of the exported audio.
    public func srt() -> String {
        cues().enumerated().map { index, cue in
            "\(index + 1)\n\(timestamp(cue.start, ",")) --> \(timestamp(cue.end, ","))\n\(cue.speaker.map { "\($0): " } ?? "")\(cue.text)\n"
        }.joined(separator: "\n")
    }

    /// WebVTT captions, timed from the start of the exported audio, with the wall-clock anchor in a note.
    public func vtt() -> String {
        let note =
            "NOTE\n\(oneLine(title))\nCue times are from the start of the exported audio, \(utc(range.lowerBound)).\n"
        return "WEBVTT\n\n\(note)\n"
            + cues().map { cue in
                "\(timestamp(cue.start, ".")) --> \(timestamp(cue.end, "."))\n\(cue.speaker.map { "<v \($0)>" } ?? "")\(cue.text)\n"
            }.joined(separator: "\n")
    }

    // MARK: Captions

    struct Cue {
        var start: Int64
        var end: Int64
        var speaker: String?
        var text: String
    }

    /// ponytail: a cue is one turn, or a piece of 84 characters of a longer one; good enough for reading along.
    static let cueCharacters = 84

    /// A turn longer than a cue is cut at spaces (or anywhere, in Thai) into pieces timed by their share of its
    /// characters: the server keeps no word times on the phone.
    func cues() -> [Cue] {
        let length = range.millis
        let clamp = { (instant: CaptureInstant) in min(max(audioMillis(instant), 0), length) }
        if let absent = absentTranscript { return [Cue(start: 0, end: length, speaker: nil, text: "[\(absent)]")] }
        var cues: [Cue] = []
        for turn in turns {
            let (start, end) = (clamp(turn.range.lowerBound), clamp(turn.range.upperBound))
            let pieces = Self.pieces(turn.text)
            let total = max(pieces.reduce(0) { $0 + $1.count }, 1)
            var done = 0
            for piece in pieces {
                let from = start + (end - start) * Int64(done) / Int64(total)
                done += piece.count
                let to = start + (end - start) * Int64(done) / Int64(total)
                cues.append(Cue(start: from, end: to, speaker: turn.speaker.displayName, text: piece))
            }
        }
        return cues
    }

    /// `text` in pieces of at most `cueCharacters`, cut at the last space before the limit when there is one.
    static func pieces(_ text: String) -> [String] {
        var pieces: [String] = []
        var rest = Substring(text.trimmingCharacters(in: .whitespacesAndNewlines))
        while rest.count > cueCharacters {
            let head = rest.prefix(cueCharacters)
            let cut = head.lastIndex(of: " ") ?? head.endIndex
            pieces.append(String(rest[..<cut]))
            rest = rest[cut...].drop { $0 == " " }
        }
        if !rest.isEmpty { pieces.append(String(rest)) }
        return pieces
    }

    private func timestamp(_ millis: Int64, _ separator: String) -> String {
        String(
            format: "%02lld:%02lld:%02lld\(separator)%03lld", millis / 3_600_000, millis / 60_000 % 60,
            millis / 1000 % 60,
            millis % 1000)
    }

    private func oneLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).joined(separator: " ").replacing("-->", with: "->")
    }
}
