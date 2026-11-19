import Foundation
import LifeConnector

/// Where this phone keeps its pairing with Life: the endpoint (not secret) in the app group's defaults, the tokens in
/// the Keychain, both readable by the notification extension. The tokens are one item, so a refresh replaces both of
/// them at once.
nonisolated struct LifeToken: TokenStore {
    private static let endpointKey = "lifeEndpoint"
    private static let account = "life-tokens"

    init() {
        // ponytail: the endpoint moved from the app's own defaults to the group's; drop this copy in rich notifications'
        // PR 5, once his phone has run this build.
        if AppGroup.defaults.data(forKey: Self.endpointKey) == nil,
            let old = UserDefaults.standard.data(forKey: Self.endpointKey)
        {
            AppGroup.defaults.set(old, forKey: Self.endpointKey)
            UserDefaults.standard.removeObject(forKey: Self.endpointKey)
        }
    }

    func load() -> LifeCredentials? {
        guard let data = AppGroup.defaults.data(forKey: Self.endpointKey),
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
        AppGroup.defaults.set(endpoint, forKey: Self.endpointKey)
    }

    func clear() {
        Keychain.delete(Self.account)
        AppGroup.defaults.removeObject(forKey: Self.endpointKey)
    }
}
