import Foundation
import Testing

@testable import LifeConnector

private let earlier = Date(timeIntervalSince1970: 1_800_000_000)
private let later = earlier.addingTimeInterval(60)

private func idris(_ name: String, picture: String? = nil) -> Party {
    Party(ref: "person:idris", name: name, kind: .person, line: nil, picture: picture.map(Party.Picture.init))
}

@MainActor private func book(_ life: FakeLife) -> PartyBook {
    PartyBook(pictures: PictureCache(directory: URL.temporaryDirectory.appending(path: "parties-\(UUID())"), api: life))
}

@MainActor @Test func anOlderReadNeverReplacesANewerParty() {
    let parties = book(FakeLife())
    parties.remember([idris("Idris Benali")], at: later, pairing: parties.pairing)
    parties.remember([idris("Idris B.")], at: earlier, pairing: parties.pairing)
    #expect(parties.byRef["person:idris"]?.name == "Idris Benali")
    parties.remember([idris("Idris Benali-Vance")], at: later, pairing: parties.pairing)
    #expect(parties.byRef["person:idris"]?.name == "Idris Benali-Vance")
}

@MainActor @Test func aReadOfTheLastPairingLeavesTheNewOneAlone() async {
    let life = FakeLife()
    let parties = book(life)
    let first = parties.pairing
    parties.startOver()
    parties.remember([idris("Idris Benali", picture: "00000000000000000000000000000a02")], at: later, pairing: first)
    await Task.yield()
    #expect(parties.byRef.isEmpty)
    #expect(life.pictureCalls.withLock { $0.isEmpty })
}

@MainActor @Test func aPictureWantOfTheLastPairingAsksNothingMoreOfTheNewOne() async {
    let life = FakeLife()
    let (held, release) = AsyncStream<Void>.makeStream()
    life.picturesHeld = {
        for await _ in held { return }
    }
    let parties = book(life)
    let ids = (0..<(PictureCache.batch + 1)).map { String(format: "%032x", $0) }
    let wanting = Task { await parties.pictures.want(ids) }
    while life.pictureCalls.withLock({ $0.isEmpty }) { await Task.yield() }
    parties.startOver()
    release.yield()
    await wanting.value
    #expect(life.pictureCalls.withLock { $0.count } == 1)
}
