import Foundation
import Security

/// One generic-password item of this app's Keychain service (the bundle id, then ".server"): readable after first
/// unlock so background work can use it, this device only, never logged. `DeviceToken` and `LifeToken` each keep one.
nonisolated enum Keychain {
    private static func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "\(Bundle.main.bundleIdentifier ?? "lifelog").server",
            kSecAttrAccount as String: account,
        ]
    }

    static func read(_ account: String) -> String? {
        var item: CFTypeRef?
        let search = query(account).merging([
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
        ]) {
            $1
        }
        guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
            return nil
        }
        return String(decoding: data, as: UTF8.self)
    }

    /// Replaces the item in one write (never a delete then an add, which a crash between would leave empty), or adds it.
    @discardableResult
    static func save(_ value: String, account: String) -> Bool {
        let fields: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updated = SecItemUpdate(query(account) as CFDictionary, fields as CFDictionary)
        guard updated == errSecItemNotFound else { return updated == errSecSuccess }
        return SecItemAdd(query(account).merging(fields) { $1 } as CFDictionary, nil) == errSecSuccess
    }

    static func delete(_ account: String) { SecItemDelete(query(account) as CFDictionary) }
}
