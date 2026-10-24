import CoreML
import Timeline

/// Silero VAD v6 (Core ML, see Resources/SILERO.md): a speech probability for every 32 ms frame, from a small recurrent
/// model whose state carries from frame to frame. Feed one stretch of audio in order with `append`, then read its 1 s
/// windows. Not thread-safe: one stretch, one task.
public final class SileroDetector {
    public static let analyzer = "silero-vad 6"
    /// A frame counts as speech from this probability; a window is speech with at least `minSpeechFrames` of them.
    static let threshold: Float = 0.3
    static let minSpeechFrames = 8  // 256 ms
    static let frame = 512
    static let frameMillis: Int64 = 32
    private static let contextSize = 64

    private let model: MLModel
    private let input: MLMultiArray
    private var hidden: MLMultiArray
    private var cell: MLMultiArray
    private var context = [Float](repeating: 0, count: contextSize)
    private var buffered: [Float] = []
    /// One per whole frame appended so far.
    private(set) var probabilities: [Float] = []

    public init() throws {
        guard let url = Bundle.module.url(forResource: "silero-vad-unified-v6.0.0", withExtension: "mlmodelc") else {
            throw CocoaError(.fileNoSuchFile)
        }
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuOnly  // a tiny model: the CPU is fastest
        model = try MLModel(contentsOf: url, configuration: configuration)
        input = try MLMultiArray(shape: [1, NSNumber(value: Self.contextSize + Self.frame)], dataType: .float32)
        hidden = try Self.zeros()
        cell = try Self.zeros()
    }

    /// Scores every whole 512-sample frame of 16 kHz audio; a partial frame waits for the next call.
    public func append(_ samples: [Float]) throws {
        buffered += samples
        var offset = 0
        while buffered.count - offset >= Self.frame {
            try score(buffered[offset..<offset + Self.frame])
            offset += Self.frame
        }
        buffered.removeFirst(offset)
    }

    /// 1 s windows over everything appended, the first starting at `start`; the trailing partial frame is padded
    /// with silence. Non-speech is labeled silence: Silero cannot tell noise from quiet.
    public func windows(start: CaptureInstant, millis: Int64) throws -> [ActivityWindow] {
        if !buffered.isEmpty { try append([Float](repeating: 0, count: Self.frame - buffered.count)) }
        return stride(from: Int64(0), to: millis, by: Int(ActivityAnalysis.windowMillis)).map { from in
            let to = min(from + ActivityAnalysis.windowMillis, millis)
            let first = min(probabilities.count, Int((from + Self.frameMillis - 1) / Self.frameMillis))
            let last = min(probabilities.count, Int((to + Self.frameMillis - 1) / Self.frameMillis))
            let frames = probabilities[first..<last].sorted()
            let median = frames.isEmpty ? 0 : Double(frames[frames.count / 2])
            let speech = frames.count { $0 >= Self.threshold } >= Self.minSpeechFrames
            return ActivityWindow(
                interval: start.advanced(by: from)..<start.advanced(by: to), activity: speech ? .speech : .silence,
                confidence: speech ? median : 1 - median, analyzer: Self.analyzer)
        }
    }

    private func score(_ frame: ArraySlice<Float>) throws {
        let pointer = input.dataPointer.assumingMemoryBound(to: Float.self)
        for (index, sample) in (context + frame).enumerated() { pointer[index] = sample }
        let output = try model.prediction(
            from: MLDictionaryFeatureProvider(dictionary: [
                "audio_input": input, "hidden_state": hidden, "cell_state": cell,
            ]))
        guard let probability = output.featureValue(for: "vad_output")?.multiArrayValue,
            let nextHidden = output.featureValue(for: "new_hidden_state")?.multiArrayValue,
            let nextCell = output.featureValue(for: "new_cell_state")?.multiArrayValue
        else { throw CocoaError(.coderReadCorrupt) }
        probabilities.append(probability[0].floatValue)
        hidden = nextHidden
        cell = nextCell
        context = Array(frame.suffix(Self.contextSize))
    }

    private static func zeros() throws -> MLMultiArray {
        let array = try MLMultiArray(shape: [1, 128], dataType: .float32)
        for index in 0..<array.count { array[index] = 0 }
        return array
    }
}
