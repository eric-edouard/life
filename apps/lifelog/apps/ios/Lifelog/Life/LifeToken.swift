import Foundation
import LifeConnector

/// Where this phone keeps its pairing with Life: the endpoint (not secret) in the app's defaults, the tokens in the
/// Keychain. The tokens are one item, so a refresh replaces both of them at once.
nonisolated struct LifeToken: TokenStore {
    private static let endpointKey = "lifeEndpoint"
    private static let account = "life-tokens"

    func load() -> LifeCredentials? {
        guard let data = UserDefaults.standard.data(forKey: Self.endpointKey),
            let endpoint = try? JSONDecoder().decode(LifeEndpoint.self, from: data),
            let held = Keychain.read(Self.account),
            let tokens = try? JSONDecoder().decode(LifeTokens.self, from: Data(held.utf8))
        else { return nil }
        return LifeCredentials(endpoint: endpoint, tokens: tokens)
    }

    func save(_ credentials: LifeCredentials) {
        guard let endpoint = try? JSONEncoder().encode(credentials.endpoint),
            let tokens = try? JSONEncoder().encode(credentials.tokens)
        else { return }
        // The tokens first: an endpoint without them reads as not paired.
        Keychain.save(String(decoding: tokens, as: UTF8.self), account: Self.account)
        UserDefaults.standard.set(endpoint, forKey: Self.endpointKey)
    }

    func clear() {
        Keychain.delete(Self.account)
        UserDefaults.standard.removeObject(forKey: Self.endpointKey)
    }
}
