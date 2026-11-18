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
}
