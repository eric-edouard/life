import Foundation
import Library
import Network
import Upload

/// The one status every tab shows (contract "App states"), as a value the toolbar item and its sheet read: from the
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
    var network = Network.unknown
    /// Recorded speech the server doesn't have yet.
    var uploading = false
    /// The owner's edits not accepted yet.
    var editsWaiting = 0
    var lastPull: Date?

    var state: State {
        if !isPaired { return .notPaired }
        if network == .none { return .offline }
        if uploading { return .uploading }
        if editsWaiting > 0 { return .editsWaiting(editsWaiting) }
        return .upToDate(lastPull)
    }
}

extension SyncStore {
    var summary: ConnectionSummary {
        ConnectionSummary(
            isPaired: isPaired, network: pullFailed && network != .none ? .none : network,
            uploading: (uploads?.unsent ?? .zero) > .zero,
            editsWaiting: pending.waiting.count, lastPull: feed.pulledAt)
    }
}

extension ConnectionSummary.State {
    var title: String {
        switch self {
        case .notPaired: "Not paired with a server"
        case .offline: "Offline"
        case .uploading: "Uploading"
        case .editsWaiting(let count): count == 1 ? "1 edit waiting" : "\(count) edits waiting"
        case .upToDate(.some): "Up to date"
        case .upToDate(nil): "Not synced yet"
        }
    }

    /// The words the toolbar shows beside the symbol; `nil` while nothing needs the owner, so only the symbol shows.
    var toolbarText: String? {
        switch self {
        case .notPaired: "Not paired"
        case .offline, .uploading, .editsWaiting: title
        case .upToDate: nil
        }
    }

    var systemImage: String {
        switch self {
        case .notPaired: "key.slash"
        case .offline: "wifi.slash"
        case .uploading: "icloud.and.arrow.up"
        case .editsWaiting: "arrow.triangle.2.circlepath.icloud"
        case .upToDate(.some): "checkmark.icloud"
        case .upToDate(nil): "icloud"
        }
    }

    var detail: String {
        switch self {
        case .notPaired: SyncStore.notPaired + " Recording and saving on this phone go on."
        case .offline:
            "This phone can't reach the server. Everything on it still works, and what waits goes once it's back."
        case .uploading: "Sending recorded audio to the server. Its words come back on their own."
        case .editsWaiting: "Your edits show here already. The server applies them with the next sync."
        case .upToDate(.some): "The server has everything from this phone."
        case .upToDate(nil): "This phone hasn't synced with the server yet."
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

    var name: String {
        switch self {
        case .unknown: "Checking"
        case .wifi: "Wi-Fi"
        case .cellular: "Cellular"
        case .wired: "Wired"
        case .other: "Connected"
        case .none: "None"
        }
    }
}

/// Why conversations wait (the feed's `waiting.reason`), as the sheet says it.
extension WaitingReason {
    var sentence: String {
        switch self {
        case .macAway: "Waiting for your Mac"
        case .creditsOut: "Waiting for ElevenLabs credits"
        case .transcriptionOff: "Transcription is off"
        case .aiOff: "AI is off"
        case .phoneQuiet: "Waiting for the Pendant's audio"
        case .unknown: "Waiting"
        }
    }

    var systemImage: String {
        switch self {
        case .macAway: "laptopcomputer"
        case .creditsOut: "creditcard"
        case .transcriptionOff, .aiOff: "pause.circle"
        case .phoneQuiet: "iphone"
        case .unknown: "hourglass"
        }
    }
}
