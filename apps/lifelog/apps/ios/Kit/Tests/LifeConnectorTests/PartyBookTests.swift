import Foundation
import Observation
import Synchronization
import Testing

@testable import LifeConnector

private let earlier = Date(timeIntervalSince1970: 1_800_000_000)
private let later = earlier.addingTimeInterval(60)
private let picture = "00000000000000000000000000000a02"

private func idris(_ name: String, picture: String? = nil) -> Party {
    Party(ref: "person:idris", name: name, kind: .person, line: nil, picture: picture.map(Party.Picture.init))
}

@MainActor private func book(_ life: FakeLife) -> PartyBook {
    PartyBook(
        pictures: PictureCache(directory: URL.temporaryDirectory.appending(path: "parties-\(UUID())"), api: life),
        generation: PairingGeneration())
}

/// A gate a test opens once: whoever waits on it goes on.
private func gate() -> (wait: @Sendable () async -> Void, open: () -> Void) {
    let (stream, continuation) = AsyncStream<Void>.makeStream()
    return ({ for await _ in stream { return } }, { continuation.yield() })
}

@MainActor @Test func anOlderReadNeverReplacesANewerParty() {
    let parties = book(FakeLife())
    let pairing = parties.generation.current
    parties.remember([idris("Idris Benali")], at: later, pairing: pairing)
    parties.remember([idris("Idris B.")], at: earlier, pairing: pairing)
    #expect(parties.byRef["person:idris"]?.name == "Idris Benali")
    parties.remember([idris("Idris Benali-Vance")], at: later, pairing: pairing)
    #expect(parties.byRef["person:idris"]?.name == "Idris Benali-Vance")
}

@MainActor @Test func aReadThatEndsAfterANewPairingAppliesNothingNotEvenItsFailure() async throws {
    let generation = PairingGeneration()
    let begun = Mutex(0)
    let (waitRead, openRead) = gate()
    let (waitFailure, openFailure) = gate()
    let read = Task {
        await generation.answer {
            begun.withLock { $0 += 1 }
            await waitRead()
            return "{}"
        }
    }
    let failing = Task {
        await generation.answer {
            begun.withLock { $0 += 1 }
            await waitFailure()
            throw MCPError.notPaired
        }
    }
    while begun.withLock({ $0 < 2 }) { await Task.yield() }
    generation.next()
    openRead()
    openFailure()
    #expect(await read.value == nil)
    #expect(await failing.value == nil)
    #expect(try await generation.answer { "{}" }?.get() == "{}")
}

@MainActor @Test func aReadOfTheLastPairingLeavesTheNewOneAlone() {
    let life = FakeLife()
    let parties = book(life)
    let first = parties.generation.current
    parties.startOver()
    #expect(parties.remember([idris("Idris Benali", picture: picture)], at: later, pairing: first) == nil)
    #expect(parties.byRef.isEmpty)
}

@MainActor @Test func picturesScheduledBeforeANewPairingAreNeverAskedOfTheNewLife() async {
    let life = FakeLife()
    let parties = book(life)
    let wanting = parties.remember([idris("Idris Benali", picture: picture)], at: later, pairing: 0)
    parties.startOver()
    await wanting?.value
    #expect(life.pictureCalls.withLock { $0.isEmpty })
}

@MainActor @Test func aPictureWantOfTheLastPairingAsksNothingMoreOfTheNewOne() async {
    let life = FakeLife()
    let (wait, open) = gate()
    life.picturesHeld = wait
    let parties = book(life)
    let ids = (0..<(PictureCache.batch + 1)).map { String(format: "%032x", $0) }
    let first = parties.generation.current
    let wanting = Task { await parties.pictures.want(ids) { parties.generation.current == first } }
    while life.pictureCalls.withLock({ $0.isEmpty }) { await Task.yield() }
    parties.startOver()
    open()
    await wanting.value
    #expect(life.pictureCalls.withLock { $0.count } == 1)
}

@MainActor @Test func aNewPairingOfTheSameLifeTellsTheScreensToReadAgain() {
    let parties = book(FakeLife())
    for _ in 0..<2 {
        let told = Mutex(false)
        withObservationTracking { _ = parties.generation.current } onChange: { told.withLock { $0 = true } }
        parties.startOver()
        #expect(told.withLock { $0 })
    }
}
