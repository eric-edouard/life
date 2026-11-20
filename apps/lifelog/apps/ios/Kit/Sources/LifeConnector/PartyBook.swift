import Foundation
import Observation

/// Everyone the reads name, by ref, as the newest read gives them, and their pictures (`pictures`). A pairing with
/// another Life starts it over (`startOver`), and a read begun under the last pairing changes nothing: a read takes
/// `pairing` when it starts and hands it back to `remember`.
@MainActor @Observable
public final class PartyBook {
    public private(set) var byRef: [String: Party] = [:]
    public let pictures: PictureCache
    /// The pairing the book holds now.
    @ObservationIgnored public private(set) var pairing = 0
    /// When each party's newest read was answered: an older read never replaces it.
    @ObservationIgnored private var readAt: [String: Date] = [:]

    public init(pictures: PictureCache) {
        self.pictures = pictures
    }

    /// Keeps each party a read answered `at` names, unless a newer read already gave them, and has their pictures on
    /// hand. A read of another pairing is dropped.
    public func remember(_ named: [Party], at: Date, pairing: Int) {
        guard pairing == self.pairing else { return }
        for party in named {
            if let newer = readAt[party.ref], at < newer { continue }
            readAt[party.ref] = at
            if byRef[party.ref] != party { byRef[party.ref] = party }
        }
        let ids = named.compactMap(\.picture?.id)
        if !ids.isEmpty { Task { await pictures.want(ids) } }
    }

    /// Another Life is paired: no party of the last one stays, and no picture of theirs is asked of the new one.
    public func startOver() {
        pairing += 1
        (byRef, readAt) = ([:], [:])
        pictures.startOver()
    }
}
