import Foundation

/// What the phone's search shows of its two reads, decided once from each read as its section shows it
/// (`ReadState.Shown`): the rows, "Nothing holds" and the title's count all follow it, so a read the screen hides (the
/// matters once Life is unpaired, any read once its pairing is lost) is never counted, listed or hinted at. Not Life's
/// `search` tool.
public struct SearchResults: Sendable {
    /// Each section as it shows; nil when the search shows no such section.
    public let people: ReadState<PeopleList>.Shown?
    public let matters: ReadState<MatterList>.Shown?
    /// What he typed, trimmed.
    public let asked: String

    /// `people` is nil when the search asks none (the Matters scope, or the field empty outside People); `matters` nil
    /// in the People scope. Unpaired, only the people's section shows, which says so.
    public init(query: String, people: ReadState<PeopleList>?, matters: ReadState<MatterList>?, isPaired: Bool) {
        asked = query.trimmingCharacters(in: .whitespaces)
        self.people = people?.shown(isEmpty: \.isNoOne)
        let isMattersShown = people == nil || isPaired
        self.matters = isMattersShown ? matters?.shown(isEmpty: { $0.matching(query).isEmpty }) : nil
    }

    /// The matters on screen that hold what he typed (every one while the field is empty).
    public var matterRows: [MatterRow]? { matters?.onScreen?.matching(asked) }

    /// "Nothing holds": he typed something and every section shown read nothing.
    public var isNothing: Bool {
        let sections = [people.map(\.isEmpty), matters.map(\.isEmpty)].compactMap(\.self)
        return !asked.isEmpty && !sections.isEmpty && sections.allSatisfy(\.self)
    }

    /// How many rows hold what he typed, from the sections on screen only; nil while he typed nothing or none shows rows.
    public var count: Int? {
        guard !asked.isEmpty else { return nil }
        let found = people?.onScreen.map { $0.people.count + ($0.others?.count ?? 0) }
        let matters = matterRows?.count
        guard found != nil || matters != nil else { return nil }
        return (found ?? 0) + (matters ?? 0)
    }
}

extension ReadState.Shown {
    /// The read landed with nothing in it.
    fileprivate var isEmpty: Bool {
        if case .empty = self { true } else { false }
    }
}
