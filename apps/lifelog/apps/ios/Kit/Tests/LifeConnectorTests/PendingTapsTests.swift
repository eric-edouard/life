import Foundation
import Testing

@testable import LifeConnector

/// Parked, then Done while Parked's write waits on Life: Done shows and sends nothing, and Parked's tap ends once.
@MainActor @Test func aSecondTapWhileTheFirstWaitsOnLifeShowsAndSendsNothing() async {
    let taps = PendingTaps<String>()
    var sent: [String] = []
    var answer: CheckedContinuation<Void, Never>?
    let first = Task {
        _ = await taps.run("shop", showing: "parked") {
            sent.append("parked")
            await withCheckedContinuation { answer = $0 }
        }
    }
    while answer == nil { await Task.yield() }
    #expect(await !taps.run("shop", showing: "done") { sent.append("done") })
    #expect(taps["shop"] == "parked")
    answer?.resume()
    await first.value
    #expect(sent == ["parked"])
    #expect(taps["shop"] == nil)
    #expect(await taps.run("shop", showing: "done") { sent.append("done") })
    #expect(sent == ["parked", "done"])
}

/// His icon pick stays under way through Life's reads after its write (`LifeStore.setMatterIcon`): Life's `key`, he
/// picks `sign`, the write goes, the matter read is held; `hammer` then sends nothing, and once the read is in, the
/// Undo of his next pick puts back `sign`, never Life's pick.
@MainActor @Test func aSecondIconPickWaitsForTheFirstPicksReads() async throws {
    func row(_ by: String, _ key: String) throws -> MatterRow {
        let icon = #"{"by": "\#(by)", "key": "\#(key)"}"#
        let text = #"{"id": "matter_x", "name": "Renew the lease", "status": "moving", "icon": \#(icon)}"#
        return try JSONDecoder().decode(MatterRow.self, from: Data(text.utf8))
    }
    let (picked, taps) = (try row("owner", "sign"), PendingTaps<String?>())
    var (shown, writes) = (try row("life", "key"), [String?]())
    var read: CheckedContinuation<Void, Never>?
    let first = Task {
        await taps.run("matter_x", showing: "sign") {
            writes.append("sign")
            await withCheckedContinuation { read = $0 }
            shown = picked
        }
    }
    while read == nil { await Task.yield() }
    #expect(taps["matter_x"] == .some("sign"))
    #expect(await !taps.run("matter_x", showing: "hammer") { writes.append("hammer") })
    read?.resume()
    #expect(await first.value)
    #expect(writes == ["sign"])
    #expect(shown.ownerIconKey == "sign")
}
