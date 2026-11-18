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
    state.apply(.failed(.notPaired))
    #expect(shown(state) == "notPaired")
}
