import Network
import Observation

/// The phone's network path, followed once for the whole app: the pendant's sync and Life's store both read it.
@Observable
final class NetworkPath {
    private(set) var network = ConnectionSummary.Network.unknown

    /// Follows the path for the life of the app; `back` runs each time it returns from none.
    func follow(back: () -> Void) async {
        #if DEBUG
            // `-offline` fails every request as if there were no network: show what the owner sees then.
            if OfflineProtocol.isRequested { return network = .none }
        #endif
        for await path in NWPathMonitor() {
            let next = ConnectionSummary.Network(path)
            let isBack = network == .none && next != .none
            if next != network { network = next }
            if isBack { back() }
        }
    }
}
