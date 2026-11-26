import AVFoundation
import Foundation
import ServerAPI

/// The server's cut of a voice (`GET transcripts/{id}/audio`), one file per job in Caches until iOS clears them: what a voice
/// card plays.
enum ClipAudio {
    nonisolated static let folder = URL.cachesDirectory.appending(path: "clips", directoryHint: .isDirectory)

    /// A job's audio on the phone, fetched first when it isn't yet; `nil` when the fetch fails.
    static func file(_ job: UUID) async -> URL? {
        let file = folder.appending(path: "\(job.uuidString.lowercased()).ogg")
        if FileManager.default.fileExists(atPath: file.path) { return file }
        guard let data = try? await ServerClient.production.jobAudio(job) else { return nil }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return (try? data.write(to: file, options: .atomic)) == nil ? nil : file
    }

    #if DEBUG
        /// A quiet tone of `seconds` as a job's audio, where `file` finds it (previews and fixtures); kept when there.
        nonisolated static func writeTone(job: String, seconds: Int) {
            let file = folder.appending(path: "\(job.lowercased()).ogg")
            // Written as .caf (the writer takes no .ogg), then named as `file` looks for it; the player reads the bytes.
            let written = file.deletingPathExtension().appendingPathExtension("caf")
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            guard !FileManager.default.fileExists(atPath: file.path),
                let format = AVAudioFormat(standardFormatWithSampleRate: 22_050, channels: 1),
                let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(22_050 * seconds)),
                let audio = try? AVAudioFile(forWriting: written, settings: format.settings)
            else { return }
            buffer.frameLength = buffer.frameCapacity
            for frame in 0..<Int(buffer.frameLength) {
                buffer.floatChannelData?[0][frame] = 0.05 * sin(Float(frame) * 2 * .pi * 220 / 22_050)
            }
            try? audio.write(from: buffer)
            try? FileManager.default.moveItem(at: written, to: file)
        }
    #endif
}
