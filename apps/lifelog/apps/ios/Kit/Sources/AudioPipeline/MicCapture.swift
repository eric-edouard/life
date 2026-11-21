import AVFoundation

/// This phone's microphone into a `DictationRecording`: the input node's taps are resampled to 16 kHz mono and handed
/// over in order. The audio session is the caller's (`AudioSessionOwner`). The recording ends on its own, its error
/// kept for `stop`, when the engine's set-up changes (the microphone's route lost), the queue overflows, or a buffer
/// can't be converted or encoded: a recording with a hole is never handed over as whole.
@MainActor
public final class MicCapture {
    public typealias Buffers = AsyncThrowingStream<AVReadOnlyAudioPCMBuffer, any Error>
    /// About 2 s of the tap's buffers waiting for the main actor.
    static let queued = 100

    public let recording: DictationRecording
    /// Told each run of 16 kHz mono samples as it is recorded (his words shown live).
    public var onSamples: (@MainActor ([Float]) -> Void)?
    private let engine = AVAudioEngine()
    private var feed: Task<Void, Never>?
    private var sink: Buffers.Continuation?
    private var configChange: NSObjectProtocol?
    private var failure: (any Error)?

    public init() throws { recording = try DictationRecording() }

    /// Opens the microphone. `ended` is told once if the recording ends on its own.
    public func start(ended: @escaping @MainActor () -> Void) throws {
        let input = engine.inputNode
        let resampler = try Resampler(from: input.outputFormat(forBus: 0))
        let (buffers, sink) = Buffers.makeStream(bufferingPolicy: .bufferingOldest(Self.queued))
        try input.installAudioTap(onBus: 0, bufferSize: 1024, format: resampler.source) { buffer, _ in
            Self.offer(buffer, to: sink)
        }
        self.sink = sink
        let recording = recording
        let heard = onSamples
        feed = Task { [weak self] in
            do {
                try await Self.take(buffers, with: resampler, into: recording, also: heard)
            } catch {
                self?.failure = error
                ended()
            }
        }
        configChange = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { _ in MainActor.assumeIsolated { ended() } }
        engine.prepare()
        try engine.start()
    }

    /// Closes the microphone at once: nothing more is heard. `stop` then takes what was.
    public func halt() {
        configChange.map(NotificationCenter.default.removeObserver)
        configChange = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        sink?.finish()  // what the tap handed over is still taken
    }

    /// Closes the microphone and returns the Ogg Opus stream of everything heard, or why it isn't whole.
    public func stop() async throws -> Data {
        halt()
        await feed?.value
        if let failure { throw failure }
        return try recording.finish()
    }

    /// The tap's side: a buffer the queue has no room for ends the stream with an overrun.
    nonisolated static func offer(_ buffer: AVReadOnlyAudioPCMBuffer, to sink: Buffers.Continuation) {
        if case .dropped = sink.yield(buffer) { sink.finish(throwing: AudioPipelineError.microphoneOverrun) }
    }

    /// The buffers in order into `recording`; the first that fails ends it, and its error is thrown.
    static func take(
        _ buffers: some AsyncSequence<AVReadOnlyAudioPCMBuffer, any Error>, with resampler: Resampler,
        into recording: DictationRecording, also: (@MainActor ([Float]) -> Void)? = nil
    ) async throws {
        for try await buffer in buffers {
            let samples = try resampler.samples(of: AVAudioPCMBuffer(copying: buffer))
            try recording.append(samples)
            also?(samples)
        }
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

    func samples(of buffer: AVAudioPCMBuffer) throws -> [Float] {
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / source.sampleRate) + 32
        guard buffer.format == source, let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
            throw AudioPipelineError.unsupportedInput
        }
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
        guard error == nil, let channel = out.floatChannelData else { throw AudioPipelineError.unsupportedInput }
        return Array(UnsafeBufferPointer(start: channel[0], count: Int(out.frameLength)))
    }
}
