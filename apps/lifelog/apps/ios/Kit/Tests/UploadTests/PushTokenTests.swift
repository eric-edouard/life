import Foundation
@testable import ServerAPI
import Testing

/// 23 Oct: a new iPhone got its token before it was paired; the one send at launch failed and nothing sent it again,
/// so the server kept waking the old phone for 11 hours. Now each run sends it until the paired server has it.
@Test func thePushTokenGoesUntilThePairedServerHasIt() async throws {
    let defaults = try #require(UserDefaults(suiteName: "push-token-\(UUID())"))
    let host = "push-token-\(UUID()).test"
    let client = RebuildServer.client(host)
    let path = "/notifications/push-token"
    let puts = { RebuildServer.requests(host, "PUT", path).count }
    RebuildServer.hosts.withLock { $0[host, default: .init()].failures[path] = [0] }

    #expect(await PushToken.send(with: client, in: defaults) == nil)  // no token yet
    PushToken.keep(Data([0xAB, 0xCD, 0xEF, 0x01, 0x23]), in: defaults)
    #expect(await PushToken.send(with: client, in: defaults)?["outcome"] == "failed")  // offline
    #expect(await PushToken.send(with: client, in: defaults) == ["outcome": "sent", "token": "abcdef01"])
    let body = try #require(RebuildServer.requests(host, "PUT", path).last?.body)
    #expect(String(decoding: body, as: UTF8.self) == #"{"token":"abcdef0123"}"#)
    #expect(await PushToken.send(with: client, in: defaults) == nil)  // the server has it
    #expect(puts() == 2)

    // Paired with another server: it goes again.
    let other = "push-token-\(UUID()).test"
    #expect(await PushToken.send(with: RebuildServer.client(other), in: defaults)?["outcome"] == "sent")
    // The next launch hands over the same token: it goes once more, in case the server dropped it.
    PushToken.keep(Data([0xAB, 0xCD, 0xEF, 0x01, 0x23]), in: defaults)
    #expect(await PushToken.send(with: client, in: defaults)?["outcome"] == "sent")
    #expect(puts() == 3)
    // A new token from iOS: it goes again.
    PushToken.keep(Data([0x99]), in: defaults)
    #expect(await PushToken.send(with: client, in: defaults)?["outcome"] == "sent")
    #expect(puts() == 4)
}
