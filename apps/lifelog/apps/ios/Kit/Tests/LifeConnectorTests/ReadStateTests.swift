import Foundation
import Synchronization
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

/// An inbox read queued behind the running one, then he pairs again (the same Life): the queued read never begins,
/// and the new pairing's read runs at once on its own pass, never joining the old one. Only the first read is held, so
/// a queue that let the old read through, or made the new one wait, fails here instead of hanging.
@MainActor @Test func aReadQueuedBeforeAPairingNeverRunsUnderTheNewOne() async {
    let generation = PairingGeneration()
    let flights = ReadFlights(generation: generation)
    let reads = Reads()
    let ran = Mutex<[String]>([])
    let isAsked = Mutex(false)
    let running = Task {
        await flights.run("inbox") {
            ran.withLock { $0.append("old running") }
            await reads.read()
        }
    }
    while reads.started < 1 { await Task.yield() }
    // On the main actor its ask is queued before its task first waits: seen asked, it is in the queue.
    let queued = Task {
        isAsked.withLock { $0 = true }
        await flights.run("inbox") { ran.withLock { $0.append("old queued") } }
    }
    while !isAsked.withLock({ $0 }) { await Task.yield() }
    generation.next()
    let fresh = Task { await flights.run("inbox") { ran.withLock { $0.append("new") } } }
    var tries = 0
    while !ran.withLock({ $0.contains("new") }), tries < 1_000 {
        tries += 1
        await Task.yield()
    }
    #expect(ran.withLock { $0.contains("new") }, "the new pairing's read began while the old one was still held")
    await reads.finishNext()
    await running.value
    await queued.value
    await fresh.value
    #expect(ran.withLock { $0 } == ["old running", "new"])
}

private let later = then.addingTimeInterval(5)

@Test func noPathMeansNoInternetWhateverTheReads() {
    var connection = LifeConnection()
    #expect(connection.whyNot(hasPath: true) == nil)
    #expect(connection.whyNot(hasPath: false) == MCPError.offline.reason)
    connection.note(ReadState<[Int]>.Event.succeeded([], then), asked: then)
    #expect(connection.whyNot(hasPath: false) == MCPError.offline.reason)
}

@Test func aReadWithNoWayToLifeHoldsUntilLifeAnswers() {
    var connection = LifeConnection()
    connection.note(ReadState<[Int]>.Event.failed(.unreachable), asked: then)
    #expect(connection.whyNot(hasPath: true) == "Your Mac is out of reach.")
    // A retry under way, one called off, or a phone with no pairing learns nothing about Life.
    for nothing in [ReadState<[Int]>.Event.started, .failed(.cancelled), .failed(.notPaired)] {
        connection.note(nothing, asked: later)
    }
    #expect(connection.lost == .unreachable)
    // The phone's own "no internet", with a path that says otherwise, stays the phone's.
    connection.note(ReadState<[Int]>.Event.failed(.offline), asked: later)
    #expect(connection.whyNot(hasPath: true) == MCPError.offline.reason)
    connection.note(ReadState<[Int]>.Event.succeeded([1], later), asked: later)
    #expect(connection.whyNot(hasPath: true) == nil)
    // Life refusing is still Life answering.
    connection.note(ReadState<[Int]>.Event.failed(.unreachable), asked: later.addingTimeInterval(1))
    connection.note(ReadState<[Int]>.Event.failed(.refused("no")), asked: later.addingTimeInterval(2))
    #expect(connection.lost == nil)
}

/// Reads of two kinds overlap: a matter's read asked first times out after the inbox's, asked later, landed.
@Test func anOlderReadLandingLateChangesNothing() {
    var connection = LifeConnection()
    connection.note(ReadState<[Int]>.Event.succeeded([1], later), asked: later)
    connection.note(ReadState<[Int]>.Event.failed(.unreachable), asked: then)
    #expect(connection.whyNot(hasPath: true) == nil)
    connection.note(ReadState<[Int]>.Event.failed(.unreachable), asked: later.addingTimeInterval(1))
    connection.note(ReadState<[Int]>.Event.succeeded([1], later), asked: later)
    #expect(connection.lost == .unreachable)
}
