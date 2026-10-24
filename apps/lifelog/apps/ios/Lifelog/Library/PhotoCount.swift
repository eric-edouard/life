import Foundation
import Photos
import Synchronization

/// How many photos and screenshots the owner's library holds from a conversation's time, for its Library row: only
/// once Photos access is granted (a conversation asks for it, the list never does), counted by creation date off the
/// main thread and kept in memory, so a row scrolled back into view costs nothing. Images only, as the conversation
/// shows them (`PhotoLibrary`).
nonisolated enum PhotoCount {
    /// By time range rather than conversation id, so a conversation that grows is counted again.
    private struct Span: Hashable {
        let start: Date
        let end: Date
    }

    /// ponytail: never invalidated, so a photo added to or deleted from an old conversation's time shows at the next
    /// launch; observe `PHPhotoLibraryChangeObserver` if that matters.
    private static let counts = Mutex<[Span: Int]>([:])

    /// The count already made for this range, if any.
    static func known(from start: Date, to end: Date) -> Int? {
        counts.withLock { $0[Span(start: start, end: end)] }
    }

    /// `nil` without Photos access.
    @concurrent static func count(from start: Date, to end: Date) async -> Int? {
        let span = Span(start: start, end: end)
        if let known = counts.withLock({ $0[span] }) { return known }
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited, !Task.isCancelled else { return nil }
        let options = PHFetchOptions()
        options.predicate = NSPredicate(
            format: "creationDate >= %@ AND creationDate < %@", start as NSDate, end as NSDate)
        let count = PHAsset.fetchAssets(with: .image, options: options).count
        counts.withLock { $0[span] = count }
        return count
    }
}
