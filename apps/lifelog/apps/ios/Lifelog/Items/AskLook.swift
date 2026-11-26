import LifeConnector
import SwiftUI

/// How one ask of Life's own is drawn, from what the wire already sends (the owner's lab picks, 26 Nov 2026): its
/// title, who it is about, which answers show and in what words, and its body. No agent word reaches him, and what
/// the server sends no data for (a link's key fact) is left out, never invented.
struct AskLook {
    let check: Check

    private func has(_ id: String) -> Bool { check.options.contains { $0.id == id } }
    /// A yes/no question to him (a guessed person, a done step, a new matter): its answers share one row.
    var isYesNo: Bool {
        [.voice, .samePerson, .contactsCard, .atOrganization, .ending, .newMatter].contains(check.group)
    }
    var isLookedFor: Bool { check.isPaymentLookedFor && check.doneSeen?.state != .notFound }

    /// The row's title: the question a card of Life's puts, as a person's own sentence.
    func title(fallback: String) -> String {
        switch check.group {
        case .voice:
            if has("is-them"), let guess = check.likelyPeople.first { return "Is this \(guess.name)?" }
            return check.question.isEmpty ? fallback : check.question
        case .samePerson: return "Same person?"
        case .guessedPerson: return check.question.isEmpty ? fallback : check.question
        case .contactsCard, .atOrganization, .ending:
            return check.question.isEmpty ? fallback : check.question
        case .newMatter:
            return fallback.components(separatedBy: ": ").dropFirst().joined(separator: ": ").nilIfEmpty ?? fallback
        default: return fallback.withoutRawDate
        }
    }

    /// Who the ask is about, when its answer is a person: the guess leads. A payment shows only the payee an account
    /// names (`Check.namedPayee`), never a guess.
    var face: ItemFace? {
        if let network = check.signedOutNetwork { return .network(network) }
        if check.group == .guessedPerson {
            return (check.networkIdentity?.party ?? check.likelyPeople.first).map { .party($0) }
        }
        if [.voice, .contactsCard, .atOrganization, .samePerson].contains(check.group) {
            return check.likelyPeople.first.map { .party($0) }
        }
        return check.namedPayee.map { .party($0) }
    }

    /// Who the row is about, under its title (the prototype's `sub`): the person's own line ("Your landlord"), what a
    /// broken network means for him, his own step, else the chat or matter it comes through.
    var line: String? {
        if check.group == .samePerson { return check.question.nilIfEmpty }
        if [.contactsCard, .atOrganization].contains(check.group) { return check.likelyPeople.first?.line }
        if check.signedOutNetwork != nil { return "Messages stop reaching Life" }
        if check.group == .yourMove { return "Your move" }
        return check.rowWho()
    }

    /// An answer in the words of the lab: plain, never "agent".
    func label(_ option: Check.Option) -> String {
        switch (check.group, option.id) {
        case (.voice, "is-them"): "Yes, that’s her"
        case (.newMatter, "start"): "Yes, start on it"
        case (.newMatter, "dismiss"): "No"
        case (.ending, "outdated"): "Yes, it’s done"
        case (.samePerson, "same-person"): "One"
        case (.samePerson, "not-this-person"): "Two"
        case (.contactsCard, "same-person"): "Someone else"
        default: option.label
        }
    }

    /// Whether an answer shows: a goal's edit stays with Start, and "I've paid" goes when Life looks for the payment
    /// itself (until it says it did not find it).
    func shows(_ option: Check.Option) -> Bool {
        if check.group == .newMatter, option.id == "edit-goal" { return false }
        if option.looks == true, isLookedFor { return false }
        // One quiet answer to a card: Later. A second put-off ("Not now", "Not yet") is never drawn.
        if ["Not now", "Not yet"].contains(option.label) { return false }
        // Its Yes is Life's guess, drawn by the card; only "Someone else" stays beside it.
        if check.group == .contactsCard, option.takes != .person { return false }
        return true
    }

    /// The body between the title and the answers.
    func body(pick: @escaping (Party) -> Void) -> some View { AskBody(check: check, look: self, pick: pick) }
}

/// What a card holds beyond its answers: the words to read along, then its own part by kind.
struct AskBody: View {
    let check: Check
    let look: AskLook
    var pick: (Party) -> Void = { _ in }

    private var specials: [Check.Need] {
        (check.needs ?? []).filter { [.link, .event, .apify].contains($0.kind) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            ForEach(Array(check.clips.enumerated()), id: \.offset) { _, clip in ReadAlong(clip: clip) }
            groupPart
            needsPart
            if check.isPlan == true, !check.planSteps.isEmpty { PlanSentence(steps: check.planSteps) }
        }
    }

    @ViewBuilder private var groupPart: some View {
        switch check.group {
        case .voice:
            if !check.options.contains(where: { $0.id == "is-them" }), !check.likelyPeople.isEmpty {
                PersonChips(people: Array(check.likelyPeople.filter { !$0.isOwner }.prefix(6)), pick: pick)
            }
        case .newMatter:
            if let goal = check.goal { AskSentence(markdown: goal) }
        case .ending:
            if let since = check.since {
                AskSentence(
                    markdown: "\(since.by.map { "\($0) wrote " } ?? "")“\(since.text)”"
                        + (check.said.map { ". Is **\($0.text)** done?" } ?? ""))
            }
        default: EmptyView()
        }
    }

    @ViewBuilder private var needsPart: some View {
        if let code = check.payCode {
            PayCodeBox(code: code)
            let rows = check.shownNeedRows
            if !rows.isEmpty { NeedRows(rows: rows) }
        } else if let needs = check.needs, !needs.isEmpty {
            ForEach(Array(specials.enumerated()), id: \.offset) { _, need in special(need) }
            let rows = needs.filter { ![.link, .event, .apify].contains($0.kind) }.flatMap(\.rows)
            ForEach(Array(rows.filter { $0.glyph == .amount }.enumerated()), id: \.offset) { _, row in
                AmountBox(text: row.text)
            }
            let others = rows.filter { $0.glyph != .amount }
            if !others.isEmpty { NeedRows(rows: others) }
        }
        if let foot { AskFoot(text: foot) }
    }

    @ViewBuilder private func special(_ need: Check.Need) -> some View {
        switch need.kind {
        case .link:
            if case .open(let url, _)? = need.rows.first?.action {
                LinkCard(url: url, line: need.rows.first?.text)
            } else {
                NeedRows(rows: need.rows)
            }
        case .event: EventBox(rows: need.rows)
        case .apify: SpendLine(line: need.line)
        default: EmptyView()
        }
    }

    /// One muted line on what a tap leads to.
    private var foot: String? {
        if check.options.contains(where: { $0.adds == true }) {
            return "Add: it goes in your calendar with these reminders."
        }
        if check.options.contains(where: { $0.runs == true }) { return "I search once and stop at the limit." }
        if check.isPaymentLookedFor {
            return check.options.contains { $0.looks == true } && !look.isLookedFor
                ? "I paid it: I look for the payment in your account and close this."
                : "Pay it your way. I see it in your bank and close this."
        }
        return nil
    }
}

extension String {
    /// A title without the date as the server wrote it ("Parents' meeting, 2026-11-19 18:00"): the slot says when.
    var withoutRawDate: String {
        replacingOccurrences(of: #",?\s*\d{4}-\d{2}-\d{2}(\s+\d{2}:\d{2})?"#, with: "", options: .regularExpression)
    }
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
