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

/// Undo waits for the tap's reads: `settled` returns when the tap under way ends, at once when none runs.
@MainActor @Test func settledWaitsForTheTapUnderWay() async {
    let taps = PendingTaps<String>()
    await taps.settled("shop")
    var answer: CheckedContinuation<Void, Never>?
    let tap = Task { _ = await taps.run("shop", showing: "parked") { await withCheckedContinuation { answer = $0 } } }
    while answer == nil { await Task.yield() }
    var isSettled = false
    let waiter = Task {
        await taps.settled("shop"); isSettled = true
    }
    await Task.yield()
    #expect(!isSettled)
    answer?.resume()
    await tap.value
    await waiter.value
    #expect(isSettled)
}
