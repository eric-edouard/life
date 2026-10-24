import AVFoundation
import SoundAnalysis
import Synchronization
import Timeline

/// The 1 s windows every analyzer labels. Labels only feed the upload policy and segmentation (`speech()`); nothing
/// is ever deleted on their word.
public enum ActivityAnalysis {
    public static let windowMillis: Int64 = 1_000
}

/// Level and zero-crossing heuristics on decoded PCM.
/// ponytail: fixed thresholds, never calibrated on Pendant audio. Tune on real days or replace with a trained VAD.
public enum EnergyDetector {
    public static let analyzer = "energy-vad 2"

    /// Labels consecutive 1 s windows of `samples` (16 kHz), the first starting at `start`. A short tail gets a
    /// shorter window.
    public static func windows(_ samples: [Float], start: CaptureInstant) -> [ActivityWindow] {
        let size = Int(ActivityAnalysis.windowMillis) * PendantAudio.samplesPerMilli
        return stride(from: 0, to: samples.count, by: size).map { offset in
            let window = samples[offset..<min(offset + size, samples.count)]
            let (activity, confidence) = label(window)
            let from = start.advanced(by: Int64(offset / PendantAudio.samplesPerMilli))
            return ActivityWindow(
                interval: from..<from.advanced(by: Int64(window.count / PendantAudio.samplesPerMilli)),
                activity: activity, confidence: confidence, analyzer: analyzer)
        }
    }

    static func label(_ window: ArraySlice<Float>) -> (Activity, Double) {
        let level = decibels(window)
        if level < -60 { return (.silence, 0.95) }
        if level < -50 { return (.silence, 0.6) }
        var crossings = 0
        for (a, b) in zip(window, window.dropFirst()) where (a < 0) != (b < 0) { crossings += 1 }
        let rate = Double(crossings) / Double(max(window.count, 1))
        // Speech rises and falls with syllables: its 20 ms levels spread more than steady noise or hum.
        let frames = stride(from: window.startIndex, to: window.endIndex, by: PendantAudio.samplesPerPacket).map {
            decibels(window[$0..<min($0 + PendantAudio.samplesPerPacket, window.endIndex)])
        }
        let mean = frames.reduce(0, +) / Double(max(frames.count, 1))
        let spread = (frames.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(max(frames.count, 1))).squareRoot()
        return (0.01...0.3).contains(rate) && spread >= 6 ? (.speech, 0.6) : (.sound, 0.6)
    }

    private static func decibels(_ samples: ArraySlice<Float>) -> Double {
        let power = samples.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(max(samples.count, 1))
        return 10 * log10(max(power, 1e-12))
    }
}

/// Apple's built-in sound classifier (`SNClassifierIdentifier.version1`, 303 labels), run on a derived file.
/// It has a "silence" label but never reports it, even for digital zero (checked on macOS 27.2), so "nothing
/// recognized" is read as silence, with low confidence.
public enum SoundClassifier {
    public static let analyzer = "sound-classifier 2"
    /// Voices worth transcribing. A room's chatter, babble or crowd is background, not speech.
    static let voiceLabels: Set = ["speech", "whispering", "shout", "yell", "laughter", "singing"]

    /// Labels consecutive 1 s windows of the file, the first starting at `start`. A trailing partial second gets no
    /// window. Synchronous and bounded by the file; call it off the main actor.
    public static func windows(file: URL, start: CaptureInstant) throws -> [ActivityWindow] {
        let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
        request.windowDuration = CMTime(value: ActivityAnalysis.windowMillis, timescale: 1_000)
        request.overlapFactor = 0
        let analyzer = try SNAudioFileAnalyzer(url: file)
        let collector = Collector(start: start)
        try analyzer.add(request, withObserver: collector)
        analyzer.analyze()
        return try collector.state.withLock { try $0.get() }
    }

    static func label(_ result: SNClassificationResult) -> (Activity, Double) {
        let voice = result.classifications.filter { voiceLabels.contains($0.identifier) }.map(\.confidence).max() ?? 0
        let top = result.classifications.map(\.confidence).max() ?? 0
        if voice >= 0.3 { return (.speech, voice) }
        if top >= 0.5 { return (.sound, top) }
        if voice < 0.1 { return (.silence, 1 - top) }
        return (.uncertain, 0.5)
    }

    /// Results arrive during `analyze()`, possibly on another thread.
    private final class Collector: NSObject, SNResultsObserving, Sendable {
        let start: CaptureInstant
        let state = Mutex<Result<[ActivityWindow], any Error>>(.success([]))

        init(start: CaptureInstant) { self.start = start }

        func request(_ request: any SNRequest, didProduce result: any SNResult) {
            guard let result = result as? SNClassificationResult else { return }
            let (activity, confidence) = SoundClassifier.label(result)
            let range = result.timeRange
            let from = start.advanced(by: Int64((range.start.seconds * 1_000).rounded()))
            let to = start.advanced(by: Int64((range.end.seconds * 1_000).rounded()))
            let window = ActivityWindow(
                interval: from..<to, activity: activity, confidence: confidence, analyzer: SoundClassifier.analyzer)
            state.withLock { state in state = state.map { $0 + [window] } }
        }

        func request(_ request: any SNRequest, didFailWithError error: any Error) {
            state.withLock { $0 = .failure(error) }
        }
    }
}
