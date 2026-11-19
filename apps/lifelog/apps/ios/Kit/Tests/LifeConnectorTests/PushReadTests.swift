import Foundation
import Testing

@testable import LifeConnector

private let empty = #"{"checks":[],"counts":{},"total":0,"deadlinesToday":0}"#

@Test func aPushReadKeepsItsOwnResultAndOnlyTheLatestPushTakesEvents() throws {
    var read: PushRead? = PushRead(id: "aaaaaaaaaaaaaaaa")
    read.apply(.failed(.notPaired), id: "aaaaaaaaaaaaaaaa")
    #expect(read?.state.phase == .notPaired)

    // A second push replaces the first; the first one's late answer changes nothing.
    read = PushRead(id: "bbbbbbbbbbbbbbbb")
    read.apply(.started, id: "bbbbbbbbbbbbbbbb")
    read.apply(.failed(.unreachable), id: "aaaaaaaaaaaaaaaa")
    #expect(read?.state.phase == .loading)
    read.apply(.succeeded(try JSONDecoder().decode(Inbox.self, from: Data(empty.utf8)), Date()), id: "bbbbbbbbbbbbbbbb")
    #expect(read?.state.phase == .loaded)

    // Cleared (the whole inbox was read): nothing late comes back.
    read = nil
    read.apply(.started, id: "bbbbbbbbbbbbbbbb")
    #expect(read == nil)
}
