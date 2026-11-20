import Foundation
import Observation

/// Everyone the reads name, by ref, as the newest read gives them, and their pictures (`pictures`). A pairing with
/// another Life starts it over (`startOver`), and a read begun under the last pairing changes nothing: a read takes the
/// generation when it starts (`generation.current`) and hands it back to `remember`.
@MainActor @Observable
public final class PartyBook {
    public private(set) var byRef: [String: Party] = [:]
    public let pictures: PictureCache
    @ObservationIgnored public let generation: PairingGeneration
    /// When each party's newest read was answered: an older read never replaces it.
    @ObservationIgnored private var readAt: [String: Date] = [:]

    public init(pictures: PictureCache, generation: PairingGeneration) {
        (self.pictures, self.generation) = (pictures, generation)
    }

    /// Keeps each party a read answered `at` names, unless a newer read already gave them, and has their pictures on
    /// hand while `pairing` holds. A read of another pairing is dropped.
    @discardableResult
    public func remember(_ named: [Party], at: Date, pairing: Int) -> Task<Void, Never>? {
        guard pairing == generation.current else { return nil }
        for party in named {
            if let newer = readAt[party.ref], at < newer { continue }
            readAt[party.ref] = at
            if byRef[party.ref] != party { byRef[party.ref] = party }
        }
        let ids = named.compactMap(\.picture?.id)
        guard !ids.isEmpty else { return nil }
        let generation = generation
        return Task { await pictures.want(ids) { generation.current == pairing } }
    }

    /// Another Life is paired: the generation moves on, and no party of the last one stays.
    public func startOver() {
        generation.next()
        (byRef, readAt) = ([:], [:])
        pictures.forgetAsked()
    }
}
