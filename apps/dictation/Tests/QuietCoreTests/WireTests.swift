import Foundation
import QuietCore
import Testing

/// The server's real answers (`fixtures/wire/`, written by `apps/server/src/wire.test.ts`), read with Host's decoder.
private let wire = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appending(path: "fixtures/wire")

@Test func theMenuReadsEveryPartOfTheServersLiveStatus() throws {
    let status = try #require(HostStatus.decode(Data(contentsOf: wire.appending(path: "status-live.json"))))
    #expect(status.pipeline?.transcription != nil && status.pipeline?.ai != nil)
    #expect(status.backup?.restic != nil)
    #expect(status.mac != nil && status.pendant != nil && status.phoneHeartbeat != nil)
    #expect(status.switches != nil)
    #expect(status.transcription != nil && status.transcription?.quota == nil, "null credits are no credits read yet")
    #expect(status.pendant?.charging?.on == true)
    let menu = Host.report(status, now: .now).filter(\.inMenu)
    let unknown = menu.filter { $0.summary.value.contains("unknown") }.map(\.summary.label)
    #expect(unknown == ["ElevenLabs credits"], "only the credits the fixture leaves null")
}
