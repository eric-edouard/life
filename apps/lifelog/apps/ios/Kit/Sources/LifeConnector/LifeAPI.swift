import Foundation

/// Life's reads, typed: the one place tool names appear. Each gives the tool's JSON text, which `LifeCodec` reads into
/// the models and `ReadCache` keeps as it came.
public protocol LifeAPI: Sendable {
    func readInbox() async throws -> String
    func readMatters() async throws -> String
    func readMatter(_ id: String) async throws -> String
    func readRegisteredAgents() async throws -> String
}

public struct MCPLifeAPI: LifeAPI {
    private let client: MCPClient

    public init(client: MCPClient) {
        self.client = client
    }

    public func readInbox() async throws -> String { try await client.call("read_inbox") }
    public func readMatters() async throws -> String { try await client.call("read_matters") }
    public func readMatter(_ id: String) async throws -> String { try await client.call("read_matter", ["id": id]) }
    public func readRegisteredAgents() async throws -> String { try await client.call("read_registered_agents") }
}
