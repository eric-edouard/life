import Foundation
import Library
import Network
import Upload

/// The pendant server's one status, as a value Settings and its page read: from the
/// token, the network path, the uploader, the outbox and the last feed pull (`SyncStore.summary`).
struct ConnectionSummary: Equatable {
    enum Network: Equatable {
        case unknown, wifi, cellular, wired, other, none
    }

    /// One state at a time, the most pressing first.
    enum State: Equatable {
        /// Nothing goes to a server until the phone is paired with one.
        case notPaired
        case offline
        case uploading
        case editsWaiting(Int)
        /// `nil`: the feed never answered (not paired, the demo library).
        case upToDate(Date?)
    }

    var isPaired = true
    /// The server refused this phone's token on the last read (`SyncStore.tokenRefused`): as good as not paired.
    var isRefused = false
    var network = Network.unknown
    /// Recorded speech the server doesn't have yet, or an upload failing (how much waits is then unknown).
    var uploading = false
    /// The owner's edits not accepted yet.
    var editsWaiting = 0
    var lastPull: Date?

    var state: State {
        if !isPaired || isRefused { return .notPaired }
        if network == .none { return .offline }
        if uploading { return .uploading }
        if editsWaiting > 0 { return .editsWaiting(editsWaiting) }
        return .upToDate(lastPull)
    }
}

extension SyncStore {
    var summary: ConnectionSummary {
        ConnectionSummary(
            isPaired: isPaired, isRefused: tokenRefused,
            network: pull.isEstablished && network != .none ? .none : network,
            uploading: (uploads?.unsent ?? .zero) > .zero || uploads?.lastError != nil,
            editsWaiting: pending.waiting.count, lastPull: feed.pulledAt)
    }
}

/// How a connection reads, everywhere (Settings' rows, its pages, Diagnostics): worked out from its `CheckOutcome`.
enum LinkState: Equatable {
    case works, checking, noAnswer, notPaired

    var mark: StateMark {
        switch self {
        case .works: StateMark(glyph: .ok, word: "Works")
        case .checking: StateMark(glyph: .busy, word: "Checking")
        case .noAnswer: StateMark(glyph: .flag, word: "No answer")
        case .notPaired: StateMark(glyph: .flag, word: "Not paired")
        }
    }
}

extension ConnectionSummary.Network {
    init(_ path: NWPath) {
        guard path.status == .satisfied else {
            self = .none
            return
        }
        let kinds: [(NWInterface.InterfaceType, Self)] = [
            (.wifi, .wifi), (.cellular, .cellular), (.wiredEthernet, .wired),
        ]
        self = kinds.first { path.usesInterfaceType($0.0) }?.1 ?? .other
    }
}

/// Why conversations wait (the feed's `waiting.reason`), as the server's page says it.
extension WaitingReason {
    var sentence: String {
        switch self {
        case .macAway: "Waiting for your Mac"
        case .creditsOut: "Waiting for ElevenLabs credits"
        case .transcriptionOff: "Transcription is off"
        case .phoneQuiet: "Waiting for the Pendant's audio"
        case .unknown: "Waiting"
        }
    }
}
