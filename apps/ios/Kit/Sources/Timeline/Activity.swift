public enum Activity: String, Sendable, Codable {
    case speech
    /// Audible but not speech: music, traffic, a door.
    case sound
    case silence
    case uncertain
}

/// One analyzer's label for a short window (about 0.5–1 s) of captured audio.
public struct ActivityWindow: Sendable, Equatable {
    public var interval: Range<CaptureInstant>
    public var activity: Activity
    /// 0...1, the analyzer's confidence in `activity`.
    public var confidence: Double
    /// Which analyzer and version produced the label, e.g. "silero-vad 6".
    public var analyzer: String

    public init(interval: Range<CaptureInstant>, activity: Activity, confidence: Double, analyzer: String) {
        self.interval = interval
        self.activity = activity
        self.confidence = confidence
        self.analyzer = analyzer
    }
}

extension Array where Element == ActivityWindow {
    /// Speech, by the one rule upload, segmentation and hint checks share. Where Silero ran, a second is speech when
    /// Silero or the sound classifier says so (each catches speech the other misses); the energy detector and the
    /// `uncertain` labels don't count there: on a train they turned four hours of rumble into one conversation.
    /// Elsewhere (files analyzed before Silero ran) any analyzer's speech counts, and `uncertain` when `orUncertain`.
    /// Sorted and disjoint.
    public func speech(orUncertain: Bool = false) -> [Range<CaptureInstant>] {
        let silero = filter(\.isSilero).map(\.interval).unioned()
        let trusted = filter { ($0.isSilero || $0.isClassifier) && $0.activity == .speech }.map(\.interval)
        let rest = filter { $0.activity == .speech || orUncertain && $0.activity == .uncertain }.map(\.interval)
            .unioned().subtracting(silero)
        return (trusted + rest).unioned()
    }

    /// Audio some analyzer heard something in: anything but silence, by every analyzer except Silero, which labels
    /// noise and quiet alike as silence. Tells noise from true quiet for the quiet-gap rules. Sorted and disjoint.
    public var audible: [Range<CaptureInstant>] {
        filter { !$0.isSilero && $0.activity != .silence }.map(\.interval).unioned()
    }

    /// The part of `audio` no analyzer labeled, which counts as possible speech. Pieces under a second are seams, not
    /// audio left to analyze: a playback file ends a few milliseconds before its span, or two files of a span don't
    /// quite meet. Counted as speech, they broke every long pause at each of the Pendant's starts and stops, and a
    /// 2.5 h coworking morning with 11 min of speech stayed one conversation (Oct 13). Sorted and disjoint.
    public func unanalyzed(_ audio: [Range<CaptureInstant>]) -> [Range<CaptureInstant>] {
        audio.subtracting(map(\.interval).unioned()).filter { $0.millis >= 1_000 }
    }
}

extension ActivityWindow {
    /// Silero VAD, any version (`SileroDetector.analyzer`).
    var isSilero: Bool { analyzer.hasPrefix("silero-vad ") }
    /// Apple's sound classifier, any version (`SoundClassifier.analyzer`).
    var isClassifier: Bool { analyzer.hasPrefix("sound-classifier ") }
}

/// Decides which audio is worth uploading for transcription: speech (`speech()`). It only plans; it never deletes
/// anything.
///
/// Audio no analyzer has reached counts as speech. Speech keeps `paddingMillis` on each side, and only gaps of at
/// least `minimumCutMillis` are cut, so pauses inside a conversation stay. No loudness test: on real days it cut the
/// owner's own phone call, and no detector tells a person nearby from a video (see docs/voice/decisions.md).
public struct SpeechPolicy: Sendable, Equatable {
    public var paddingMillis: Int64 = 1_000
    public var minimumCutMillis: Int64 = 3_000

    public init() {}

    /// The audio to upload, sorted and disjoint. Quiet ranges (the owner dictating to the Mac, or this app playing a
    /// recording out loud; already padded) are left out whatever the analyzers heard. They still count as speech when
    /// conversations are split.
    public func keptAudio(
        spans: [CaptureSpan], windows: [ActivityWindow], quietRanges: [Range<CaptureInstant>] = []
    ) -> [Range<CaptureInstant>] {
        let spans = spans.map(\.interval).unioned()
        let speech = windows.speech().map {
            $0.lowerBound.advanced(by: -paddingMillis)..<$0.upperBound.advanced(by: paddingMillis)
        }
        let unanalyzed = windows.unanalyzed(spans)
        var kept: [Range<CaptureInstant>] = []
        for range in (speech + unanalyzed).unioned() {
            if let last = kept.last, last.upperBound.distance(to: range.lowerBound) < minimumCutMillis {
                kept[kept.count - 1] = last.lowerBound..<range.upperBound
            } else {
                kept.append(range)
            }
        }
        return spans.subtracting(spans.subtracting(kept)).subtracting(quietRanges.unioned())
    }
}
