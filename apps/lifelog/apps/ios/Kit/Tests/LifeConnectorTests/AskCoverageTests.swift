import Foundation
import Library
import Testing

@testable import LifeConnector

private func decoded<V: Decodable>(_ type: V.Type, _ name: String) throws -> V {
    try LibraryStore.feedDecoder.decode(type, from: Data(wireText("life/\(name).json").utf8))
}

private let kit = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent()
private let kitSources = kit.appending(path: "Sources/LifeConnector")
private let lifeFixtures = kit.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appending(path: "fixtures/wire/life")

/// Every key of every ask fixture, at any depth.
private func keys(in value: Any) -> Set<String> {
    switch value {
    case let object as [String: Any]: Set(object.keys).union(object.values.flatMap(keys(in:)))
    case let array as [Any]: Set(array.flatMap(keys(in:)))
    default: []
    }
}

/// Keys the phone leaves unread on purpose: a done line's internals (`via`, `schemaVersion`, `seenAt`: the result's own
/// fields say the outcome) and an apify need's money (`estimateUsd`, `maxUsd`: its `line` says them in Life's words).
private let notFields: Set<String> = ["via", "schemaVersion", "seenAt", "estimateUsd", "maxUsd"]

/// A fixture the server wrote holds a key no Kit type names: the phone would drop what Life sent.
@Test func noAskFixtureKeyIsDroppedByTheKit() throws {
    let source = try FileManager.default.subpathsOfDirectory(atPath: kitSources.path).filter { $0.hasSuffix(".swift") }
        .map { try String(contentsOf: kitSources.appending(path: $0), encoding: .utf8) }.joined(separator: "\n")
    let names = try FileManager.default.contentsOfDirectory(atPath: lifeFixtures.path)
    var dropped: [String] = []
    for name in names where name.hasPrefix("ask_") || name.hasPrefix("read_thread") || name.hasPrefix("answer_check") {
        let object = try JSONSerialization.jsonObject(with: Data(wireText("life/\(name)").utf8))
        for key in keys(in: object).subtracting(notFields)
        where source.range(of: "\\b\(key)\\b", options: .regularExpression) == nil {
            dropped.append("\(name): \(key)")
        }
    }
    #expect(dropped.isEmpty, "keys no Kit type reads: \(dropped)")
}

/// A card's parts (flags, edits, follow, changed) all decode from what the server wrote.
@Test func aCardWithEveryPartDecodes() throws {
    let cards = try decoded([Check].self, "ask_card_parts")
    let options = cards.flatMap(\.options)
    #expect(options.contains { $0.adds == true } && options.contains { $0.runs == true })
    #expect(options.contains { $0.looks == true })
    #expect(cards.contains { $0.edits != nil } && cards.contains { $0.follow != nil })
    #expect(cards.contains { !($0.changed ?? []).isEmpty })
}

/// An `adds` answer wrote one calendar event: the result says which, so it is never written twice.
@Test func anAddsAnswerCarriesItsEvent() throws {
    let result = try decoded(AnswerResult.self, "answer_check_added")
    #expect(result.changed?.added?.eventId == "evt_made_up")
    #expect(result.done?.contains { $0.kind == "added" } == true)
}

/// A `runs` answer started one Apify run, once.
@Test func aRunsAnswerCarriesItsRun() throws {
    let result = try decoded(AnswerResult.self, "answer_check_ran")
    #expect(result.changed?.ran?.runId != nil)
    #expect(result.done?.contains { $0.kind == "ran" } == true)
}

/// His rating of a closed card goes out as `rate`, and the answer's `done` line says it was kept.
@Test func aRatingIsSentAndRecorded() throws {
    let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(AnswerRequest.rating("dec_1", .good)))
    #expect((body as? [String: Any])?["rate"] as? String == "good")
    let result = try decoded(AnswerResult.self, "answer_check_rated")
    #expect(result.done?.contains { $0.kind == "rated" } == true)
}

/// A thread entry carries what was handed on from it, with the estimate, and its reactions.
@Test func aThreadEntryCarriesItsHandedWorkAndReactions() throws {
    let read = try decoded(ThreadRead.self, "read_thread_handed")
    let handed = read.entries.flatMap(\.handed)
    #expect(!handed.isEmpty && handed.contains { $0.estimateMs != nil })
    #expect(read.entries.contains { !$0.reactions.isEmpty })
}
