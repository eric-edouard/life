import Foundation
import Library
import Timeline

/// Everything needed to export one conversation, read from the library's cache beforehand. Exporting is pure: it
/// never fetches, transcribes or generates anything, so it can never trigger paid work.
public struct ConversationExport: Sendable {
    public var conversation: CachedConversation
    /// Exactly what is exported, in capture time; usually the conversation's range. Turns and fixes are
    /// included when they start inside it. Exported audio starts at its lower bound.
    public var range: Range<CaptureInstant>
    public var turns: [CachedTurn]
    public var chapters: [CachedChapter]
    public var observations: [PlaceObservation]
    /// Stretches inside `range` the Pendant did not record; the exported audio holds silence there.
    public var unrecorded: [Range<CaptureInstant>]
    /// Wall-clock times in text exports use this zone.
    public var timeZone: TimeZone

    public init(
        conversation: CachedConversation, range: Range<CaptureInstant>? = nil, turns: [CachedTurn],
        chapters: [CachedChapter] = [], observations: [PlaceObservation] = [],
        unrecorded: [Range<CaptureInstant>] = [], timeZone: TimeZone
    ) {
        let range = range ?? conversation.range
        self.conversation = conversation
        self.range = range
        self.turns = turns.filter { range.contains($0.start) }
        self.chapters = chapters.filter { range.contains($0.start) }
        self.observations = observations.filter { range.contains($0.at) }
        self.unrecorded = unrecorded.map { $0.clamped(to: range) }.filter { !$0.isEmpty }
        self.timeZone = timeZone
    }

    /// Reads one conversation (or `range` of it) from the cache. Only reads. Stretches no audio covers are
    /// `unrecorded`. `nil` when the cache has no such conversation.
    public static func load(
        _ id: UUID, range: Range<CaptureInstant>? = nil, from library: LibraryStore, audio: [AudioSource],
        timeZone: TimeZone
    ) async throws -> ConversationExport? {
        guard let conversation = try await library.conversation(id) else { return nil }
        let range = range ?? conversation.range
        return ConversationExport(
            conversation: conversation, range: range,
            turns: try await library.turns(of: conversation.id).filter { range.contains($0.start) },
            chapters: try await library.chapters(of: conversation.id),
            observations: try await library.observations(in: range),
            unrecorded: RangeAudio.unrecorded(in: range, sources: audio), timeZone: timeZone)
    }

    public var title: String { conversation.shownTitle ?? "Untitled conversation" }

    /// Milliseconds into the exported audio.
    public func audioMillis(_ instant: CaptureInstant) -> Int64 { range.lowerBound.distance(to: instant) }

    /// Said instead of a transcript, so an export is never silently empty. `nil` when there is text.
    public var absentTranscript: String? {
        turns.isEmpty ? "No words were transcribed in this range." : nil
    }
}

// MARK: Time formatting (locale-independent, so output is byte-stable)

extension ConversationExport {
    private func components(_ instant: CaptureInstant, in zone: TimeZone) -> DateComponents {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let date = Date(timeIntervalSince1970: Double(instant.millis / 1000))
        return calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    }

    /// "09:12:03" local.
    func clock(_ instant: CaptureInstant) -> String {
        let parts = components(instant, in: timeZone)
        return String(format: "%02d:%02d:%02d", parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
    }

    /// "2026-10-07" local.
    func day(_ instant: CaptureInstant) -> String {
        let parts = components(instant, in: timeZone)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// "Asia/Jakarta, UTC+07:00"
    var zoneLabel: String {
        let seconds = timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: Double(range.lowerBound.millis) / 1000))
        let sign = seconds < 0 ? "-" : "+"
        return "\(timeZone.identifier), UTC\(sign)"
            + String(format: "%02d:%02d", abs(seconds) / 3600, abs(seconds) % 3600 / 60)
    }

    /// "2026-10-07 09:12:03 – 09:47:10 (Asia/Jakarta, UTC+07:00)"; the end carries its date when it differs.
    var when: String {
        let (start, end) = (range.lowerBound, range.upperBound)
        let endDay = day(end) == day(start) ? "" : day(end) + " "
        return "\(day(start)) \(clock(start)) – \(endDay)\(clock(end)) (\(zoneLabel))"
    }
}

/// "2026-10-07T02:12:03.000Z"
func utc(_ instant: CaptureInstant) -> String {
    let date = Date(timeIntervalSince1970: Double(instant.millis / 1000))
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .gmt
    let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    return String(
        format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0,
        parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0, Int(((instant.millis % 1000) + 1000) % 1000))
}
