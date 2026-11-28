import Foundation
import MacLink
import ServerAPI

/// The server this phone is paired with and its bearer token: the token in the Keychain (this device only, readable
/// after first unlock so background processing can use it, never logged), the server in the app's defaults. A pairing
/// link (`Pairing`, a QR code on the server's Mac) sets both.
nonisolated enum DeviceToken {
    private static let serverKey = "pairedServer"
    /// The Mac link the server is reached over (`mac`, `relay`), beside it; absent: directly.
    private static let macLinkKey = "pairedServerMacLink"

    /// The paired server: one only with a token beside it.
    static var paired: URL? {
        read() == nil ? nil : UserDefaults.standard.url(forKey: serverKey)
    }

    static var macLink: MacLinkAddress? {
        UserDefaults.standard.stringArray(forKey: macLinkKey).flatMap {
            $0.count == 2 ? MacLinkAddress(mac: $0[0], relay: $0[1]) : nil
        }
    }

    /// Keeps a pairing: the token, then the server and its Mac link. Returns whether the Keychain took the token.
    static func pair(_ pairing: Pairing) -> Bool {
        guard save(pairing.token) else { return false }
        UserDefaults.standard.set(pairing.macLink.map { [$0.mac, $0.relay] }, forKey: macLinkKey)
        UserDefaults.standard.set(pairing.server, forKey: serverKey)
        return true
    }

    private static let account = "device-token"

    static func read() -> String? { Keychain.read(account) }

    @discardableResult
    static func save(_ token: String) -> Bool { Keychain.save(token, account: account) }

    #if DEBUG
        /// Development only: launch with `LIFELOG_DEVICE_TOKEN` and `LIFELOG_SERVER_URL` in the environment (for
        /// example `SIMCTL_CHILD_LIFELOG_DEVICE_TOKEN=… xcrun simctl launch …`) to pair with that server, http too.
        /// Never in release builds.
        static func importFromEnvironment() {
            let environment = ProcessInfo.processInfo.environment
            guard let token = environment["LIFELOG_DEVICE_TOKEN"], !token.isEmpty,
                let server = environment["LIFELOG_SERVER_URL"].flatMap(URL.init(string:)),
                token != read() || server != paired, save(token)
            else { return }
            UserDefaults.standard.set(server, forKey: serverKey)
        }
    #endif
}
