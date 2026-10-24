import AudioPipeline
import Capture
import Foundation
import Library
import ServerAPI
import Timeline

/// An event for the app's log (`bun run events`): a name and its fields, ids, counts and times only, never content.
public typealias AppEvent = @Sendable (String, [String: String]) -> Void

extension Duration {
    var millis: Int64 { Int64(self / .milliseconds(1)) }
}

/// The process's CPU time so far, every thread's, in milliseconds.
var cpuMillis: Int64 { Int64(clock_gettime_nsec_np(CLOCK_PROCESS_CPUTIME_ID) / 1_000_000) }

/// The phone's one run (docs/sync.md). Its steps, in order:
///
/// 1. **The outbox**: the owner's edits, in the order made, before anything else, so an edit never waits behind
///    derived audio or a backlog.
/// 2. **Derived audio**: playback files and speech labels for new pages; once a day, playback files whose audio ended
///    over a week ago go (playing one rebuilds it).
/// 3. **The feed**, pulled into the cache: the newest quiet ranges, so fragments leave the Mac's dictation out, and
///    the fragments the server withdrew, whose pages go again.
/// 4. **The push token**, once the feed reached the server, until the paired server has it (`PushToken`): the server
///    wakes the phone only with it.
/// 5. **The uploader**: speech fragments, then timeline facts.
/// 6. **The location history**.
///
/// The raw backup is no step: one item can take minutes, so it goes in a lane of its own beside the runs
/// (`Uploader.backUp`, which the app starts), and new speech never waits for it. A step that can't reach the server
/// throws and the run stops there (after derived audio, which needs no server): the next one starts again from the top,
/// and nothing is lost or sent twice. Without a capture half (a simulated Pendant in the simulator) only the outbox and
/// the feed run. Each run ends with a `run.done` event: its milliseconds and the process's CPU milliseconds (`cpuMs`),
/// and each step it finished with its own (`audio 1200/950`: wall/CPU).
public struct Driver: Sendable {
    /// What a run does with the phone's own audio.
    public struct Capture: Sendable {
        let worker: DerivedAudioWorker
        let uploader: Uploader

        public init(worker: DerivedAudioWorker, uploader: Uploader) {
            self.worker = worker
            self.uploader = uploader
        }
    }

    let library: LibraryStore
    let client: ServerClient
    let capture: Capture?
    let event: AppEvent

    public init(library: LibraryStore, client: ServerClient, capture: Capture?, event: @escaping AppEvent = { _, _ in })
    {
        self.library = library
        self.client = client
        self.capture = capture
        self.event = event
    }

    public var uploader: Uploader? { capture?.uploader }

    /// One run, steps in order. `status`: the Pendant's as the run starts, what it vouches is saved
    /// (`FactsBuilder.savedThrough`). Returns whether it changed the server's data screens show: an edit settled, or
    /// the feed brought something. New audio alone doesn't count: it moves every run while the Pendant records, and the
    /// feed follows within minutes.
    @discardableResult
    public func run(_ status: CaptureStatus) async throws -> Bool {
        let start = (wall: ContinuousClock.now, cpu: cpuMillis)
        var lap = start
        var steps: [String] = []
        func done(_ step: String) {
            let now = (wall: ContinuousClock.now, cpu: cpuMillis)
            steps.append("\(step) \(lap.wall.duration(to: now.wall).millis)/\(now.cpu - lap.cpu)")
            lap = now
        }
        defer {
            event(
                "run.done",
                [
                    "ms": "\(start.wall.duration(to: .now).millis)", "cpuMs": "\(cpuMillis - start.cpu)",
                    "steps": steps.joined(separator: ", "),
                ])
        }
        // The edits first; if they can't go, the phone's own derived audio still runs before the run stops.
        var unsent: (any Error)?
        var changed = false
        do {
            changed = try await Outbox.replay(library, client: client)
        } catch {
            unsent = error
        }
        done("outbox")
        // Read before the store is scanned: what the status vouches for is already saved.
        let savedThrough = FactsBuilder.savedThrough(status)
        if let capture {
            try? await capture.worker.requeueStaleAnalysis()
            await capture.worker.run { try await capture.uploader.scanner.index($0) }
            let evicted = UserDefaults.standard.object(forKey: Self.evictedKey) as? Date ?? .distantPast
            if Date.now.timeIntervalSince(evicted) > 86_400, (try? await capture.worker.evictPlayback()) != nil {
                UserDefaults.standard.set(Date.now, forKey: Self.evictedKey)
            }
            done("audio")
        }
        if let unsent { throw unsent }
        // A failed pull doesn't hold the speech back: the uploader runs with the quiet ranges it has.
        var unpulled: (any Error)?
        do {
            changed = try await pull() || changed
            done("feed")
        } catch {
            unpulled = error
        }
        if unpulled == nil, let fields = await PushToken.send(with: client) {
            event("push.device_token", fields)
        }
        if let capture {
            try await capture.uploader.run(savedThrough: savedThrough)
            done("upload")
        }
        if let unpulled { throw unpulled }
        guard capture != nil else { return changed }
        try await sendLocations()
        done("locations")
        return changed
    }

    private static let evictedKey = "playbackEvictedAt"

    /// The feed from the cache's cursor, page after page; `wait` holds the first request while nothing is newer.
    /// Returns whether it brought anything (the cursor moved).
    @discardableResult
    public func pull(wait: Int = 0) async throws -> Bool {
        let start = try await library.feedCursor()
        var cursor = start
        var more = true
        var hold = wait
        while more {
            let data = try await client.feed(since: cursor, wait: hold)
            // A fragment the server withdrew (a quiet range touched it) moves the uploader's cursor back.
            let page = try await library.apply(feed: data) { try await uploader?.withdrawn($0) }
            (cursor, more, hold) = (page.cursor, page.more, 0)
        }
        return cursor != start
    }

    /// Fixes and visits the server's location history doesn't have yet, a batch at a time.
    func sendLocations() async throws {
        while !Task.isCancelled {
            let (fixes, visits) = try await library.unsentLocations(limit: 500)
            if fixes.isEmpty && visits.isEmpty { return }
            try await client.addLocationHistory(fixes: fixes, visits: visits)
            try await library.markSent(fixes: fixes, visits: visits)
        }
    }
}
