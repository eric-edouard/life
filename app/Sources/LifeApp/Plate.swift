import Foundation

/// The plate (`snapshot`, src/plate.ts): every part of Life as a card in a group, as the watcher serves it on this Mac.
struct Plate: Decodable, Equatable {
  let cards: [Card]
  let groups: [Group]
  let observedAt: Date
  let today: [Tick]
  let trouble: [String]
  let worst: Tone

  struct Group: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
  }

  var troubled: [Card] { cards.filter { trouble.contains($0.id) } }
  /// The colour of "n to look at": red when anything is broken.
  var troubleTone: Tone { worst == .bad ? .bad : .warn }
  func cards(in group: String) -> [Card] { cards.filter { $0.group == group } }
}

/// A status colour: always shown with a word.
enum Tone: String, Decodable {
  case bad, busy, idle, ok, teal, warn
}

struct Card: Decodable, Equatable, Identifiable {
  /// A sentence to paste into a Claude session, when the part is in trouble.
  let ask: String?
  let at: Date?
  /// His words and errors' text: shown only while Show content is on.
  let content: [String]?
  let facts: [Fact]
  let group: String
  let headline: String
  let id: String
  let name: String
  let stations: [Station]?
  let tone: Tone
  let word: String

  struct Fact: Decodable, Equatable, Hashable {
    let at: Date?
    let label: String
    let value: String?
  }

  struct Station: Decodable, Equatable, Hashable {
    let name: String
    let state: String
  }
}

/// One mark on the last 24 hours: a run, an email, a sleep.
struct Tick: Decodable, Equatable, Hashable {
  let at: Date
  let end: Date?
  let label: String
  /// The Mac asleep: a band, not a run.
  let sleep: Bool?
  let tone: Tone
}

/// A card's history and raw log lines (`detail`, src/plate-detail.ts), each with where it goes on.
struct Detail: Decodable {
  let history: [Entry]
  let log: [String]
  let next: Next

  struct Next: Decodable {
    let history: String?
    let log: String?
  }

  struct Entry: Decodable, Hashable {
    let at: Date?
    let content: String?
    let run: String?
    let sub: String?
    let title: String
    let tone: Tone
  }
}

/// A run's steps and what it wrote (`runDetail`, src/plate-detail.ts).
struct RunView: Decodable {
  let steps: [Step]
  let use: String?
  let wrote: Wrote

  struct Step: Decodable, Identifiable {
    let endedAt: Date?
    let id: String
    let outcome: String
    let result: Counts?
    let startedAt: Date?
    let step: String
    let tone: Tone
    let use: String?
  }

  struct Wrote: Decodable {
    let byType: [String: Int]
  }
}

/// A step's numeric counters as it logged them, in key order; anything else it logged is left out.
struct Counts: Decodable {
  let text: String

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    text = c.allKeys.map(\.stringValue).filter { $0 != "ms" }.sorted()
      .compactMap { k in (try? c.decode(Int.self, forKey: Key(k))).map { "\(k) \($0)" } }
      .joined(separator: " · ")
  }

  struct Key: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue s: String) { stringValue = s }
    init?(intValue: Int) { nil }
  }
}

extension JSONDecoder {
  /// Life's instants: ISO 8601, with milliseconds or without.
  static func life() -> JSONDecoder {
    let d = JSONDecoder()
    d.dateDecodingStrategy = .custom { decoder in
      let s = try decoder.singleValueContainer().decode(String.self)
      if let at = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(s) { return at }
      return try Date.ISO8601FormatStyle().parse(s)
    }
    return d
  }
}
