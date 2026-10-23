import Foundation
import Library
import Timeline

extension ServerClient {
    /// A fragment's capture-time map: its kept stretches in upload order, `separatorMs` of silence between them.
    public struct FragmentMap: Sendable, Codable, Equatable {
        public var segments: [[Int64]]
        public var separatorMs: Int64

        public init(segments: [Range<CaptureInstant>]) {
            self.segments = segments.map { [$0.lowerBound.millis, $0.upperBound.millis] }
            separatorMs = TimeMap.separatorMillis
        }
    }

    public struct FragmentMetadata: Sendable, Encodable, Equatable {
        /// Inclusive page ranges, sorted and disjoint.
        public var pages: [[UInt64]]
        public var map: FragmentMap
        public var audioSha256: String
        public var durationSeconds: Double

        public init(pages: [[UInt64]], map: FragmentMap, audioSha256: String, durationSeconds: Double) {
            self.pages = pages
            self.map = map
            self.audioSha256 = audioSha256
            self.durationSeconds = durationSeconds
        }
    }

    /// The pages the server holds of a source, every job's and every fragment's, old parts included once the
    /// handover gave them pages, and whether the handover happened. The uploader sends around these pages, and
    /// rebuilds its cursor from this after a reinstall or a restore.
    public struct SourceBlocks: Sendable, Decodable, Equatable {
        public struct Block: Sendable, Decodable, Equatable {
            public var pages: [[UInt64]]

            /// `pages` as inclusive ranges; a malformed pair is left out.
            public var ranges: [ClosedRange<UInt64>] {
                pages.compactMap { $0.count == 2 && $0[0] <= $0[1] ? $0[0]...$0[1] : nil }
            }
        }

        public var handedOver: Bool
        public var blocks: [Block]
    }

    /// Uploads one speech fragment. Idempotent: the same pages and audio answer the same fragment; pages the server
    /// holds already answer 409 `held`.
    public func putSpeech(source: String, firstPage: UInt64, audio: URL, metadata: FragmentMetadata) async throws {
        _ = try await upload(
            audio: audio, metadata: try JSONEncoder().encode(metadata),
            to: try request("sources/\(source)/speech/\(firstPage)", method: "PUT"))
    }

    public func blocks(source: String) async throws -> SourceBlocks {
        try decode(SourceBlocks.self, try await send(try request("sources/\(source)/blocks")))
    }

    /// Sends `audio` (Ogg Opus) and its JSON `metadata`, if any, as one multipart body.
    func upload(audio: URL, metadata: Data? = nil, to request: URLRequest) async throws -> Data {
        let boundary = "lifelog-\(UUID().uuidString)"
        var body = Data()
        func field(_ name: String, filename: String? = nil, type: String, _ content: Data) {
            body += Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"".utf8)
            if let filename { body += Data("; filename=\"\(filename)\"".utf8) }
            body += Data("\r\nContent-Type: \(type)\r\n\r\n".utf8) + content + Data("\r\n".utf8)
        }
        if let metadata { field("metadata", type: "application/json", metadata) }
        field("audio", filename: audio.lastPathComponent, type: "audio/ogg", try Data(contentsOf: audio))
        body += Data("--\(boundary)--\r\n".utf8)
        var request = request
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        return try await send(request, body: body)
    }
}
