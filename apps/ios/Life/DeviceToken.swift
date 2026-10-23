import Foundation
import Security
import ServerAPI

/// The server this phone is paired with and its bearer token: the token in the Keychain (this device only, readable
/// after first unlock so background processing can use it, never logged), the server in the app's defaults. A pairing
/// link (`Pairing`, a QR code on the server's Mac) sets both.
nonisolated enum DeviceToken {
    private static let serverKey = "pairedServer"

    /// The paired server: one only with a token beside it.
    static var paired: URL? {
        read() == nil ? nil : UserDefaults.standard.url(forKey: serverKey)
    }

    /// Keeps a pairing: the token, then the server. Returns whether the Keychain took the token.
    static func pair(_ pairing: Pairing) -> Bool {
        guard save(pairing.token) else { return false }
        UserDefaults.standard.set(pairing.server, forKey: serverKey)
        return true
    }

    private static var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            // The app's bundle id (`LIFE_BUNDLE_ID`), then ".server".
            kSecAttrService as String: "\(Bundle.main.bundleIdentifier ?? "lifelog").server",
            kSecAttrAccount as String: "device-token",
        ]
    }

    static func read() -> String? {
        var item: CFTypeRef?
        let search = query.merging([kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]) {
            $1
        }
        guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
            return nil
        }
        return String(decoding: data, as: UTF8.self)
    }

    @discardableResult
    static func save(_ token: String) -> Bool {
        SecItemDelete(query as CFDictionary)
        let item = query.merging([
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]) { $1 }
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

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
