#if DEBUG
    import AVFoundation
    import Timeline

    extension DerivedAudioDirectory {
        /// The playback file named `file` of a device.
        public func audioURL(file: String, deviceID: String) -> URL {
            directory(deviceID).appending(path: file)
        }

        /// Encodes 16 kHz mono PCM as one playback file, then writes its sidecar last, like the worker. It is for fixtures
        /// and tests: there are no source pages behind it, so it carries no activity labels or decode gaps. `samples`
        /// returns the samples of a sample range; it is called in chunks, so a long file is never held whole.
        @discardableResult
        public func writePlayback(
            deviceID: String, pages: ClosedRange<UInt64>, start: CaptureInstant, millis: Int64,
            samples: (Range<Int>) -> [Float]
        ) throws -> PlaybackSegment {
            try FileManager.default.createDirectory(at: directory(deviceID), withIntermediateDirectories: true)
            let url = audioURL(deviceID, pages: pages)
            let file = try AVAudioFile(
                forWriting: url, settings: PlaybackEncoding.settings, commonFormat: .pcmFormatFloat32,
                interleaved: false)
            let total = Int(millis) * PendantAudio.samplesPerMilli
            let chunk = Int(DerivedAudioWorker.chunkMillis) * PendantAudio.samplesPerMilli
            for first in stride(from: 0, to: total, by: chunk) {
                try file.write(from: PendantAudio.buffer(samples(first..<min(first + chunk, total))))
            }
            file.close()
            let segment = PlaybackSegment(
                deviceID: deviceID, file: url.lastPathComponent, pages: pages,
                interval: start..<start.advanced(by: millis),
                decodeGaps: [], windows: [])
            try write(segment)
            return segment
        }
    }
#endif
