import AVFoundation

/// This phone's microphone into a `DictationRecording`: the input node's taps are resampled to 16 kHz mono and handed
/// over in order. The audio session is the caller's (`AudioSessionOwner`); a change of the engine's set-up (the
/// microphone's route lost) ends it.
@MainActor
public final class MicCapture {
    public let recording: DictationRecording
    private let engine = AVAudioEngine()
    private var feed: Task<Void, Never>?
    private var sink: AsyncStream<AVReadOnlyAudioPCMBuffer>.Continuation?
    private var configChange: NSObjectProtocol?

    public init() throws { recording = try DictationRecording() }

    /// Opens the microphone. `ended` is told once if the engine stops on its own.
    public func start(ended: @escaping @MainActor () -> Void) throws {
        let input = engine.inputNode
        let resampler = try Resampler(from: input.outputFormat(forBus: 0))
        let (buffers, sink) = AsyncStream<AVReadOnlyAudioPCMBuffer>.makeStream()
        try input.installAudioTap(onBus: 0, bufferSize: 1024, format: resampler.source) { buffer, _ in
            sink.yield(buffer)
        }
        self.sink = sink
        let recording = recording
        feed = Task {
            for await buffer in buffers {
                try? recording.append(resampler.samples(of: AVAudioPCMBuffer(copying: buffer)))
            }
        }
        configChange = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { _ in MainActor.assumeIsolated { ended() } }
        engine.prepare()
        try engine.start()
    }

    /// Closes the microphone and returns the Ogg Opus stream of everything heard.
    public func stop() async throws -> Data {
        configChange.map(NotificationCenter.default.removeObserver)
        configChange = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        sink?.finish()  // what the tap handed over is still taken
        await feed?.value
        return try recording.finish()
    }
}

/// One input format to 16 kHz mono float. The converter keeps its filter's state between buffers, so a stream
/// resampled in pieces matches one resampled whole.
final class Resampler {
    let source: AVAudioFormat
    private let target: AVAudioFormat
    private let converter: AVAudioConverter

    init(from source: AVAudioFormat) throws {
        guard
            let target = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: Double(PendantAudio.sampleRate), channels: 1,
                interleaved: false),
            let converter = AVAudioConverter(from: source, to: target)
        else { throw AudioPipelineError.unsupportedInput }
        self.source = source
        self.target = target
        self.converter = converter
    }

    func samples(of buffer: AVAudioPCMBuffer) -> [Float] {
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / source.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return [] }
        var given = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if given {
                status.pointee = .noDataNow
                return nil
            }
            given = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = out.floatChannelData else { return [] }
        return Array(UnsafeBufferPointer(start: channel[0], count: Int(out.frameLength)))
    }
}
