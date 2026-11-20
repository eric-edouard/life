import LifeConnector
import SwiftUI

/// What he has typed or opened on a card.
struct CardInput: Equatable {
    var isWritingOwnWords = false
    var words = ""
    var showsWhy = false
}

/// A link on the ask and what it does: "Why?" or "Tell the agent…".
struct AskLink {
    let title: String
    let run: () -> Void
}

/// A card's answers inside its panel: the deadline's line, the first option filled, the others in one row when they are
/// few and short and fit, else each on a row of its own. An option that takes more than a tap asks for it: who it is
/// ("Same as…"), or his words. `links` are the ask's links that the row under the thing does not hold: at the right end
/// of the deadline's line.
struct CheckActions: View {
    let check: Check
    @Binding var input: CardInput
    /// His answer is being sent or saved: its busy pill stands in for the answers.
    let isBusy: Bool
    let links: [AskLink]
    let answer: (AnswerRequest) -> Void
    let sameAs: () -> Void
    let create: (String) -> Void

    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(LifeStore.self) private var life

    private var words: String { input.words.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: Metrics.Spacing.s) {
            if input.isWritingOwnWords {
                Button {
                    if let request = check.answer(words: words) { answer(request) }
                } label: {
                    Text(check.group == .newMatter ? "Save the goal" : "Send my answer")
                }
                .buttonStyle(.pill(.filled))
                .disabled(words.isEmpty)
                Button("Back to the options") { input.isWritingOwnWords = false }.buttonStyle(
                    .pill(.quiet, size: .compact))
            } else if isBusy {
                Button {
                } label: {
                    Text(check.draft != nil ? "Sending…" : "Saving…")
                }
                .buttonStyle(.pill(.quiet, isBusy: true)).disabled(true)
            } else {
                line
                refusal
                DoneSeenLine(doneSeen: check.doneSeen)
                // While Life looks, its answer stands busy in the filled answer's place: nothing to tap.
                if check.doneSeen?.state == .looking {
                    Button {
                    } label: {
                        Text(check.doneSeen?.line ?? "Checking…")
                    }
                    .buttonStyle(.pill(.filled, isBusy: true)).disabled(true)
                } else if check.doneSeen?.state != .seen {
                    // Seen: Life ends the card; a stale read of it offers nothing to tap.
                    options
                }
            }
        }
        .motion(Motion.standard, value: check.doneSeen?.state)
    }

    /// His last answer to this ask that did not go, in one `flag` line above the same answers; a send that someone wrote
    /// over names their message too (Life's own word, `wrote`: never decided here).
    @ViewBuilder private var refusal: some View {
        if case .failed(let failure, _) = life.state(of: .answer(ref: check.ref)) {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                if let wrote = failure.wrote {
                    let by = wrote.by ?? check.draft?.to ?? "Someone"
                    Text("Not sent: \(by) wrote since.").font(.small).foregroundStyle(Palette.flag)
                    if let text = wrote.text {
                        let when = wrote.at.map { ", \($0.formatted(.dateTime.hour().minute()))" } ?? ""
                        Text("\(by)\(when)").font(.small).foregroundStyle(Palette.muted)
                        Text("“\(text)”").font(.body15).foregroundStyle(Palette.fg).fixedSize(
                            horizontal: false, vertical: true)
                    }
                } else {
                    // Life's own reason when Life answered; the fixed line only when the connection failed.
                    Text(failure.isSameTap ? "Not sent to your Mac." : failure.reason)
                        .font(.small).foregroundStyle(Palette.flag)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).appears()
        }
    }

    /// The deadline in one line above the answers, with the link at its right end when the row under the thing had none.
    @ViewBuilder private var line: some View {
        let text = check.deadlineLine()
        if text != nil || !links.isEmpty {
            // Under an accessibility size the links go under the words, and under each other, never cut.
            let layout =
                typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading)) : AnyLayout(HStackLayout(spacing: Metrics.Spacing.m))
            layout {
                if let text { Text(text).font(.small).foregroundStyle(Palette.muted) }
                if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                layout {
                    ForEach(links, id: \.title) { link in TextLink(link.title, action: link.run) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private struct Choice: Identifiable {
        let id: String
        let label: String
        let run: () -> Void
    }

    /// The options the answers draw: a new matter's goal edit is the goal's pencil, never an answer.
    private var shown: [Check.Option] {
        check.options.filter { !(check.group == .newMatter && $0.takes == .note) }
    }

    /// The people it may be, each one tap away, when the card fills no answer of its own ("Yes"): a Contacts card, a voice, a name.
    private var people: [Party] {
        check.isNamingFilled ? check.likelyPeople : []
    }

    @ViewBuilder private var options: some View {
        if !people.isEmpty {
            ForEach(people, id: \.ref) { person in
                Button {
                    if let request = check.answer(naming: .person(person.ref)) { answer(request) }
                } label: {
                    PersonAnswer(person: person)
                }
                .buttonStyle(PersonAnswerStyle())
            }
            others(shown.map { option in Choice(id: option.id, label: label(of: option)) { tap(option) } })
        } else if check.createsByName, let name = check.askedName {
            // "Create <name>" opens the create sheet: not an answer yet, so nothing is held.
            Button {
                create(name)
            } label: {
                Label("Create \(name)", systemImage: "person.badge.plus").lineLimit(1)
            }
            .buttonStyle(.pill(.filled))
            others(shown.map { option in Choice(id: option.id, label: label(of: option)) { tap(option) } })
        } else if let first = shown.first {
            Button(label(of: first)) { tap(first) }.buttonStyle(.pill(.filled))
            let rest = shown.dropFirst().map { option in
                Choice(id: option.id, label: label(of: option)) { tap(option) }
            }
            if !rest.isEmpty { others(rest) }
        }
    }

    /// The server's words, except the filled naming answer with no candidate drawn: "Name them…" (a voice) or
    /// "Someone I know…" (a name).
    private func label(of option: Check.Option) -> String {
        guard check.isNamingFilled, people.isEmpty, option.id == check.namingOption?.id else { return option.label }
        switch check.group {
        case .voice: return "Name them…"
        case .name: return "Someone I know…"
        default: return option.label
        }
    }

    /// One row of 44 (`AnswerRow`) when there are at most three, each of three words or fewer, and the row holds them;
    /// else rows of 48.
    @ViewBuilder private func others(_ rest: [Choice]) -> some View {
        let isShort = rest.count <= 3 && rest.allSatisfy { $0.label.split(separator: " ").count <= 3 }
        let stack = VStack(spacing: Metrics.Spacing.s) {
            ForEach(rest) { choice in Button(choice.label, action: choice.run).buttonStyle(.pill(.quiet, size: .row)) }
        }
        if isShort && !typeSize.isAccessibilitySize {
            ViewThatFits(in: .horizontal) {
                AnswerRow {
                    ForEach(rest) { choice in
                        Button(choice.label, action: choice.run).buttonStyle(.pill(.quiet, size: .compact))
                            .lineLimit(1).minimumScaleFactor(0.75)
                    }
                }
                stack
            }
        } else {
            stack
        }
    }

    /// One tap answers; an option that names someone opens "Same as…".
    private func tap(_ option: Check.Option) {
        if let request = check.answer(option) { return answer(request) }
        switch option.takes {
        case .person?, .personOrName?: sameAs()
        // A note, or what this build doesn't know yet: his own words go back, never a dead button.
        case .note?, .unknown?: if check.takesOwnWords { input.isWritingOwnWords = true }
        case nil: break
        }
    }
}
