import Foundation
import Testing

@testable import LifeConnector

private let then = Date(timeIntervalSince1970: 1_000)

private func shown(_ state: ReadState<[Int]>) -> String {
    switch state.shown(isEmpty: \.isEmpty) {
    case .loading: "loading"
    case .loaded(let value): "loaded \(value)"
    case .empty: "empty"
    case .stale(let value, let since, let why): "stale \(value) \(Int(since.timeIntervalSince1970)) \(why)"
    case .unreachable: "unreachable"
    case .failed(let reason): "failed \(reason)"
    case .notPaired: "notPaired"
    }
}

@Test func withNoValueTheStateIsThePhase() {
    var state = ReadState<[Int]>()
    #expect(shown(state) == "loading")
    state.apply(.started)
    #expect(shown(state) == "loading")
    state.apply(.failed(.unreachable))
    #expect(shown(state) == "unreachable")
    state.apply(.failed(.refused("no")))
    #expect(shown(state) == "failed no")
    state.apply(.failed(.notPaired))
    #expect(shown(state) == "notPaired")
}

@Test func aLoadedValueIsLoadedOrEmpty() {
    var state = ReadState<[Int]>()
    state.apply(.succeeded([1, 2], then))
    #expect(shown(state) == "loaded [1, 2]")
    #expect(state.loadedAt == then)
    state.apply(.succeeded([], then))
    #expect(shown(state) == "empty")
}

@Test func aRefreshNeverBlanksTheScreen() {
    var state = ReadState<[Int]>()
    state.apply(.succeeded([1], then))
    state.apply(.started)
    #expect(shown(state) == "loaded [1]")
    #expect(state.phase == .loading)
}

/// Leaving the screen cancels its read: what was shown before stays, never "failed: cancelled".
@Test func aCancelledReadLeavesTheStateAsItWas() {
    var state = ReadState<[Int]>()
    state.apply(.succeeded([1], then))
    state.apply(.failed(.unreachable))
    state.apply(.started)
    state.apply(.failed(.cancelled))
    #expect(shown(state) == "stale [1] 1000 unreachable")
    var fresh = ReadState<[Int]>()
    fresh.apply(.succeeded([2], then))
    fresh.apply(.started)
    fresh.apply(.failed(MCPError.of(URLError(.cancelled))))
    #expect(shown(fresh) == "loaded [2]")
    #expect(MCPError.of(CancellationError()) == .cancelled)
}

@Test func aFailureAfterAGoodReadShowsTheValueAsStale() {
    var state = ReadState<[Int]>()
    state.apply(.succeeded([1], then))
    state.apply(.failed(.unreachable))
    #expect(shown(state) == "stale [1] 1000 unreachable")
    state.apply(.failed(.failed("boom")))
    #expect(shown(state) == "stale [1] 1000 failed(\"boom\")")
    state.apply(.succeeded([2], then.addingTimeInterval(5)))
    #expect(shown(state) == "loaded [2]")
}

@Test func losingThePairingShowsNoOldValue() {
    var state = ReadState<[Int]>()
    state.apply(.succeeded([1], then))
    #expect(state.shown().onScreen == [1])
    state.apply(.failed(.unreachable))
    // Stale, still on screen: its count stays.
    #expect(state.shown().onScreen == [1])
    state.apply(.failed(.notPaired))
    #expect(shown(state) == "notPaired")
    // The value outlives the pairing, but nothing on screen, a title's count included, reads it.
    #expect(state.value == [1] && state.shown().onScreen == nil)
}

@Test func aFirstReadThatDidNotLandNeedsARetry() {
    var state = ReadState<[Int]>()
    state.apply(.started)
    state.apply(.failed(.cancelled))
    #expect(state.needsRetry)
    state.apply(.started)
    #expect(!state.needsRetry)
    state.apply(.failed(.unreachable))
    #expect(state.needsRetry)
    state.apply(.failed(.refused("no")))
    #expect(state.needsRetry)
}

@Test func aReadThatLandedOrCannotBePairedNeverRetries() {
    var state = ReadState<[Int]>()
    state.apply(.failed(.notPaired))
    #expect(!state.needsRetry)
    state.apply(.succeeded([], then))
    #expect(shown(state) == "empty")
    #expect(!state.needsRetry)
    state.apply(.failed(.unreachable))
    #expect(!state.needsRetry)
}

@Test func theRetryWaitDoublesThenSettlesAtThirtySeconds() {
    let waits = (0..<8).map { firstReadRetryDelay(attempt: $0) }
    #expect(waits == [1, 2, 4, 8, 16, 30, 30, 30].map { Duration.seconds($0) })
}

/// Reads asked one after the other, each told when it may finish.
@MainActor private final class Reads {
    var started = 0
    var running = 0
    var overlapped = false
    var gates: [CheckedContinuation<Void, Never>] = []
    var shown = ReadState<[Int]>()
    /// Which reads began, by name.
    var ran: [String] = []

    func read() async {
        started += 1
        running += 1
        overlapped = overlapped || running > 1
        await withCheckedContinuation { gates.append($0) }
        running -= 1
    }

    /// Lets the oldest waiting read finish, once one waits.
    func finishNext() async {
        while gates.isEmpty { await Task.yield() }
        gates.removeFirst().resume()
    }
}

/// Two inbox reads asked one after the other: the older lists an answered card, the newer not. The newer waits for the
/// older and runs after it, so the older can never land last and bring the card back.
@MainActor @Test func aLaterReadRunsAfterTheOneRunningSoTheOlderNeverLandsLast() async {
    let flights = ReadFlights(generation: PairingGeneration())
    let reads = Reads()
    let first = Task {
        await flights.run("inbox") {
            await reads.read(); reads.shown.apply(.succeeded([1], then))
        }
    }
    while reads.started < 1 { await Task.yield() }
    let second = Task {
        await flights.run("inbox") {
            await reads.read(); reads.shown.apply(.succeeded([], then.addingTimeInterval(1)))
        }
    }
    for _ in 0..<10 { await Task.yield() }
    #expect(reads.started == 1)
    await reads.finishNext()
    await reads.finishNext()
    await first.value
    await second.value
    #expect(!reads.overlapped && reads.started == 2)
    #expect(shown(reads.shown) == "empty")
}

/// Several asks during one read make one more pass, and each asker is free once the pass after its ask ended.
@MainActor @Test func asksDuringAReadMakeOneMorePassAndNoneWaitsLonger() async {
    let flights = ReadFlights(generation: PairingGeneration())
    let reads = Reads()
    var done: [String] = []
    let first = Task {
        await flights.run("inbox", reads.read); done.append("first")
    }
    while reads.started < 1 { await Task.yield() }
    let second = Task {
        await flights.run("inbox", reads.read); done.append("second")
    }
    let third = Task {
        await flights.run("inbox", reads.read); done.append("third")
    }
    let other = Task {
        await flights.run("matters", reads.read); done.append("other")
    }
    await reads.finishNext()
    await first.value
    #expect(done == ["first"])
    // The pass after it, for both later asks, and another kind's read beside it.
    while reads.started < 3 { await Task.yield() }
    await reads.finishNext()
    await reads.finishNext()
    await second.value
    await third.value
    await other.value
    #expect(reads.started == 3)
    #expect(Set(done) == ["first", "second", "third", "other"])
}

/// A card in hand (a tapped push's) shows with the read's own faces: loaded while it reads, stale when it failed.
@Test func aValueInHandShowsWithTheReadsOwnPhase() {
    var state = ReadState<[Int]>()
    state.apply(.started)
    #expect(shown(state.showing([7], at: then)) == "loaded [7]")
    state.apply(.failed(.unreachable))
    #expect(shown(state.showing([7], at: then)) == "stale [7] 1000 unreachable")
    state.apply(.succeeded([1], then.addingTimeInterval(5)))
    #expect(state.showing([7, 1], at: then).loadedAt == then.addingTimeInterval(5))
}

/// An inbox read queued behind the running one, then he pairs again (the same Life): the queued read never begins, so
/// nothing of the old pairing's ask reaches the new Life, and the new pairing's read runs on its own pass, never
/// joining the old one.
@MainActor @Test func aReadQueuedBeforeAPairingNeverRunsUnderTheNewOne() async {
    let generation = PairingGeneration()
    let flights = ReadFlights(generation: generation)
    let reads = Reads()
    let running = Task {
        await flights.run("inbox") {
            reads.ran.append("old running"); await reads.read()
        }
    }
    while reads.started < 1 { await Task.yield() }
    let queued = Task {
        await flights.run("inbox") {
            reads.ran.append("old queued"); await reads.read()
        }
    }
    for _ in 0..<10 { await Task.yield() }
    generation.next()
    let fresh = Task {
        await flights.run("inbox") {
            reads.ran.append("new"); await reads.read()
        }
    }
    while reads.started < 2 { await Task.yield() }
    await reads.finishNext()
    await reads.finishNext()
    await running.value
    await queued.value
    await fresh.value
    #expect(reads.ran == ["old running", "new"] && reads.started == 2)
}
