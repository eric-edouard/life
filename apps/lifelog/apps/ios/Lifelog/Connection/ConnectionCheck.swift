import LifeConnector
import ServerAPI
import SwiftUI

/// The two connections a phone has, and the words each one is checked and paired with.
enum Connection: Hashable, Identifiable {
    case life, server

    var id: Self { self }
    var name: String { self == .life ? "Life" : "Pendant server" }
    /// Who answers, as a line says it.
    fileprivate var answerer: String { self == .life ? "The Mac" : "The server" }
}

/// How far a pairing has got: asking the other side to accept this phone, then reading with it (Life's inbox).
enum PairStep { case accepting, reading }

/// What a connection's reads found, worked out from its state after they ran. Never stored: the page, the Settings row
/// and Diagnostics all read the same state.
enum CheckOutcome: Equatable {
    case works, unreachable, notPaired
    /// It answered, but what it read did not decode.
    case unreadable(String)
}

extension LifeStore {
    var outcome: CheckOutcome {
        switch inbox.phase {
        case .unreachable: .unreachable
        case .notPaired: .notPaired
        case .failed(let reason): .unreadable(reason)
        case .idle, .loading, .loaded: isPaired ? .works : .notPaired
        }
    }
}

extension SyncStore {
    var outcome: CheckOutcome {
        switch summary.state {
        case .notPaired: .notPaired
        case .offline: .unreachable
        case .uploading, .editsWaiting, .upToDate: .works
        }
    }
}

/// The three lines a check shows and the reason under a failed one: all the words, none of the state.
enum ConnectionCheck {
    /// Answers, knows this phone, reads: the first line a failure reaches is the one that fails, the rest wait.
    static func lines(_ connection: Connection, _ outcome: CheckOutcome?) -> [CheckLine] {
        let words = [
            "\(connection.answerer) answers", "It knows this phone",
            connection == .life ? "The inbox reads" : "The feed reads",
        ]
        let failed: Int? =
            switch outcome {
            case .unreachable: 0
            case .notPaired: 1
            case .unreadable: 2
            case .works, nil: nil
            }
        return words.enumerated().map { index, text in
            let mark: CheckLine.Mark =
                if outcome == nil {
                    .running
                } else if let failed {
                    index < failed ? .passed : index == failed ? .failed : .waiting
                } else {
                    .passed
                }
            return CheckLine(id: "\(connection.id)-\(index)", text: text, mark: mark)
        }
    }

    static func reason(_ connection: Connection, _ outcome: CheckOutcome) -> String? {
        switch outcome {
        case .works: nil
        case .unreachable:
            connection == .life
                ? "The Mac did not answer. It may be asleep or offline."
                : "The server did not answer. Audio waits on this phone."
        case .notPaired:
            "\(connection.answerer) does not know this phone any more. Pair again."
        case .unreadable(let reason): reason
        }
    }

    /// What a pairing that failed says, and whether it was the link itself that failed (its first line).
    static func failure(_ error: any Error) -> (reason: String, isLink: Bool) {
        switch error {
        case MCPError.wrongCode: ("This link has expired. Make a new one on the Mac.", true)
        case ServerClient.ClientError.server(401, _, _):
            ("The server did not accept this link's token. Make a new one on the Mac.", true)
        case is Pairing.NotKept: ("This iPhone could not keep the pairing.", false)
        case is ServerClient.ClientError, is URLError: (SyncStore.sentence(error), false)
        default: (MCPError.of(error).reason, false)
        }
    }
}
