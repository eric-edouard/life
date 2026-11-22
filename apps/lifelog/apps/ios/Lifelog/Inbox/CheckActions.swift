import LifeConnector
import SwiftUI

/// What he has typed or opened on a card.
struct CardInput: Equatable {
    var isWritingOwnWords = false
    /// The option that took him to his words, when one did: his words go with it; none for a general reply.
    var option: String?
    var words = ""
    /// The context the sheet shows (`ContextSheet`), copied when he opened it; nil while closed.
    var context: Check.OpenedContext?
    /// The trip to his bank app from this card (`BankTrip`).
    var bankTrip = BankTrip()
}

/// A card's answers, in one zone (decision 98) and one rule for every card (`answers-v2-2026-11-22.md`): the deadline's
/// line, then at most two rows. Two answers share one row, the first filled; with more, the first (or the people, his
/// bank app, "Create …") is full width and the rest share the row below, each icon above its label, his own words
/// ("Tell the agent…") always last. An option that takes more than a tap asks for it: who it is ("Same as…"), or his words.
struct CheckActions: View {
    let check: Check
    @Binding var input: CardInput
    /// His answer is being sent or saved: its busy pill stands in for the answers.
    let isBusy: Bool
    let answer: (AnswerRequest) -> Void
    let sameAs: () -> Void
    /// The create sheet, with the name he would create, set to an organization or not.
    let create: (String, _ asOrganization: Bool) -> Void
    /// "Wrong…" on a card of Life's: its sheet.
    let wrong: () -> Void
    /// The program of the agent that asked, whose mark is the `agent` icon (a terminal when none is known).
    var runtimeName: RuntimeName?
    /// The answer he gave while Life works on it: its button says so in place, working then Life's green word, and
    /// the others wait dimmed (`answer-states-2026-11-20.md`); nil at rest.
    var pressed: Taken?

    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(LifeStore.self) private var life
    @Environment(\.askSheetZoom) private var sheetZoom
    @AppStorage(Transfers.thai.storageKey) private var thaiBankApp = Transfers.thai.usual
    @AppStorage(Transfers.iban.storageKey) private var ibanBankApp = Transfers.iban.usual

    private var words: String { input.words.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: Metrics.Spacing.s) {
            if let pressed, pressedChoice == nil, pressedPerson == nil {
                // His words or a person he named in a sheet: the one answer, working then Life's green word.
                pressedButton(pressed, kind: .filled, size: .large)
            } else if input.isWritingOwnWords {
                Button {
                    if let request = check.answer(words: words, option: input.option) { answer(request) }
                } label: {
                    // His words go to whoever hears them, never "Send": that is only ever the message itself.
                    Text(
                        check.group == .newMatter
                            ? "Save the goal" : "Tell \(check.hearer(among: life.agents.value?.agents ?? []))")
                }
                .buttonStyle(.pill(.filled))
                .disabled(words.isEmpty).offWhileOutOfReach()
                // Only navigation: it stays on while Life is out of reach.
                Button("Back to the options") { input.isWritingOwnWords = false }.buttonStyle(
                    .pill(.quiet, size: .compact))
            } else if isBusy {
                Button {
                } label: {
                    WorkingWords(words: check.draft != nil ? "Sending…" : "Saving…", key: .answer(ref: check.ref))
                }
                .buttonStyle(.pill(.quiet, isBusy: true)).disabled(true)
            } else {
                Group { answersAndLines }.offWhileOutOfReach()
                // Only navigation: "Wrong…" opens its sheet, which is itself off while Life is out of reach.
                wrongButton
            }
        }
        .motion(Motion.standard, value: check.doneSeen?.state)
        .motion(Motion.standard, value: isBusy)
    }

    @ViewBuilder private var answersAndLines: some View {
        line
        refusal
        if let problem = input.bankTrip.problem {
            Text(problem).font(.small).foregroundStyle(Palette.flag)
                .frame(maxWidth: .infinity, alignment: .leading).appears()
        }
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

    /// On Life's own asks only, the escape hatch: a compact quiet button, always the last thing at the bottom right.
    @ViewBuilder private var wrongButton: some View {
        if check.misread != nil {
            Button(action: wrong) {
                Label("Wrong…", systemImage: "exclamationmark.bubble").lineLimit(1)
            }
            .buttonStyle(.pill(.quiet, size: .compact)).fixedSize()
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
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

    /// The deadline in one line above the answers.
    @ViewBuilder private var line: some View {
        if isLookingAfterBank {
            HStack(spacing: Metrics.Spacing.s) {
                Spinner(size: .small)
                Text("Looking for the payment…").font(.small).foregroundStyle(Palette.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if let text = check.deadlineLine() {
            Text(text).font(.small).foregroundStyle(Palette.muted).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private struct Choice: Identifiable {
        /// His own words, or an option by its id: an option may be called anything, so the two never share an id.
        enum ID: Hashable { case ownWords, option(String) }
        let id: ID
        let label: String
        /// Its answer icon (Life's word, `answerIconOf`); none drawn for nil or a key this build doesn't know.
        var icon: AnswerIcon?
        /// The sheet the tap opens, which zooms out of this answer; nil for an answer.
        var sheet: AskSheet?
        let run: () -> Void
    }

    private func choice(_ option: Check.Option) -> Choice {
        Choice(id: .option(option.id), label: label(of: option), icon: option.icon, sheet: sheet(of: option)) {
            tap(option)
        }
    }

    /// An answer's words with its icon: beside them, or above them in a tile. `done` is Life's green check; `agent` the
    /// asking agent's mark.
    @ViewBuilder private func words(_ choice: Choice, isTile: Bool, isHalf: Bool = false) -> some View {
        if isTile {
            VStack(spacing: Metrics.Spacing.xs) {
                icon(of: choice).font(.buttonLabel)
                Text(choice.label)
            }
        } else {
            HStack(spacing: Metrics.Spacing.s) {
                icon(of: choice)
                // A half holds its label on one line, shrinking a little rather than wrapping.
                Text(choice.label).lineLimit(isHalf ? 1 : 3).minimumScaleFactor(isHalf ? 0.75 : 1)
            }
        }
    }

    /// The icon in the label's colour, Life's done check in green; nothing for none.
    @ViewBuilder private func icon(of choice: Choice) -> some View {
        if let symbol = choice.icon == .agent ? (runtimeName ?? .unknown).mark : choice.icon?.symbol {
            if choice.icon == .done {
                Image(symbol: symbol).foregroundStyle(Palette.ok)
            } else {
                Image(symbol: symbol)
            }
        }
    }

    /// The sheet a tap on `option` opens, if any (`tap` goes by it).
    private func sheet(of option: Check.Option) -> AskSheet? {
        if check.createsOrganizationBySheet(option), check.askedName != nil {
            return .create(ref: check.ref, asOrganization: true)
        }
        if check.answer(option) == nil, [.person, .personOrName].contains(option.takes) {
            return .people(ref: check.ref)
        }
        return nil
    }

    /// The options the answers draw, in Kit's order: a new matter's goal edit is the goal's pencil, never an answer.
    private static func shown(_ check: Check) -> [Check.Option] {
        check.optionsInOrder.filter { !(check.group == .newMatter && $0.takes == .note) }
    }
    private var shown: [Check.Option] { Self.shown(check) }

    /// What leads the answers, the one press: the people it may be, "Create <name>", his bank app, else the first option.
    private enum Lead { case people, create(String), bank(Transfers), first(Check.Option), none }

    private static func lead(of check: Check) -> Lead {
        if check.isNamingFilled, !check.likelyPeople.isEmpty { return .people }
        if check.createsByName, let name = check.askedName { return .create(name) }
        if let transfers = check.transfers { return .bank(transfers) }
        return shown(check).first.map { .first($0) } ?? .none
    }

    /// The answers float in the card's bottom bar (decision 97) when they are one short zone: no people to pick, and
    /// at most one row under the lead; a taller group (an older card's four options) stays at the end of the card's scroll.
    static func fitsBar(_ check: Check) -> Bool {
        let options = shown(check)
        let tell = check.takesOwnWords ? 1 : 0
        switch lead(of: check) {
        case .people: return false
        case .first: return options.count - 1 + tell <= Self.perRow
        case .create, .bank, .none: return options.count + tell <= Self.perRow
        }
    }

    /// The most answers that share a row: three, a third of the card each, so every label holds 14 characters.
    private static let perRow = 3

    /// His own words, always the last answer on a question: "Tell the agent…", or "Ask Life…".
    private var tell: Choice? {
        guard check.takesOwnWords else { return nil }
        return Choice(id: .ownWords, label: check.ownWordsTitle, icon: .agent) {
            input.option = nil
            input.isWritingOwnWords = true
        }
    }

    /// The people it may be, each one tap away, when the card fills no answer of its own ("Yes"): a Contacts card, a voice, a name.
    private var people: [Party] {
        check.isNamingFilled ? check.likelyPeople : []
    }

    @ViewBuilder private var options: some View {
        switch Self.lead(of: check) {
        case .people:
            ForEach(people, id: \.ref) { person in
                PartyPick(party: person, press: press(of: person)) {
                    if let request = check.answer(naming: .person(person.ref)) { answer(request) }
                }
                .opacity(pressed == nil || person.ref == pressedPerson ? 1 : 0.35)
                .disabled(pressed != nil && person.ref != pressedPerson)
            }
            others(quiet(shown.map(choice)))
        case .create(let name):
            // "Create <name>" opens the create sheet: not an answer yet, so nothing is held.
            Button {
                create(name, false)
            } label: {
                Label("Create \(name)", systemImage: "person.badge.plus").lineLimit(1)
            }
            .buttonStyle(.pill(.filled))
            .zoomSource(AskSheet.create(ref: check.ref, asOrganization: false), in: sheetZoom)
            others(quiet(shown.map(choice)))
        case .bank(let transfers):
            let app = transfers == .thai ? thaiBankApp : ibanBankApp
            // His bank app is the one press; every answer sits quieter beside it.
            Button {
                goToBank(app)
            } label: {
                HStack(spacing: Metrics.Spacing.s) {
                    Text(
                        input.bankTrip.isUnderWay
                            ? "Opening \(app.name)…"
                            : check.payCode != nil && !input.bankTrip.isCodeSaved
                                ? "Save QR and open \(app.name)" : "Open \(app.name)"
                    )
                    Image(systemName: "arrow.up.right").font(.smallStrong)
                }
            }
            .buttonStyle(.pill(.filled, isBusy: input.bankTrip.isUnderWay)).disabled(input.bankTrip.isUnderWay)
            others(quiet(shown.map(choice)))
        case .first(let first):
            let rest = quiet(shown.dropFirst().map(choice))
            if rest.count == 1, let other = rest.first, !typeSize.isAccessibilitySize {
                // Two answers: one row, halves, each icon beside its label.
                HStack(spacing: Metrics.Spacing.s) {
                    answerButton(choice(first), kind: .filled, size: .large, isHalf: true)
                    answerButton(other, kind: .quiet, size: .large, isHalf: true)
                }
            } else {
                answerButton(choice(first), kind: .filled, size: .large)
                others(rest)
            }
        case .none:
            EmptyView()
        }
    }

    /// Back from his bank app on a card Life looks for, it says so in the deadline's place: Life's watcher looks while
    /// the card is open.
    private var isLookingAfterBank: Bool { input.bankTrip.hasOpenedApp && check.isPaymentLookedFor }

    /// Saves the card's QR to Photos the first time, then opens his bank app (`BankTrip.press`), on this card's trip.
    private func goToBank(_ app: BankApp) {
        let trip = $input.bankTrip
        let save = Self.saving(check.payCode?.payload)
        Task {
            await BankTrip.press(
                get: { trip.wrappedValue }, set: { trip.wrappedValue = $0 }, save: save,
                open: {
                    guard let url = app.url else { return false }
                    return await UIApplication.shared.open(url)
                }, appName: app.name)
        }
    }

    /// The save of the card's QR to Photos, nil when the card draws none.
    private static func saving(_ payload: String?) -> (@MainActor @Sendable () async -> String?)? {
        guard let payload else { return nil }
        return { await QRPicture.save(payload) }
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

    /// The quiet answers in order, his own words last.
    private func quiet(_ answers: [Choice]) -> [Choice] { answers + (tell.map { [$0] } ?? []) }

    /// The answers under the lead: rows of tiles, three at most each, icons above labels (in practice one row: the
    /// server allows no more); each on a row of 48 at accessibility sizes; nothing when there are none.
    @ViewBuilder private func others(_ answers: [Choice]) -> some View {
        if typeSize.isAccessibilitySize {
            VStack(spacing: Metrics.Spacing.s) {
                ForEach(answers) { choice in answerButton(choice, kind: .quiet, size: .row) }
            }
        } else {
            let rows = stride(from: 0, to: answers.count, by: Self.perRow).map {
                Array(answers[$0..<min($0 + Self.perRow, answers.count)])
            }
            ForEach(rows.indices, id: \.self) { i in
                HStack(spacing: Metrics.Spacing.s) {
                    ForEach(rows[i]) { choice in
                        answerButton(choice, kind: .quiet, size: .tile).minimumScaleFactor(0.75)
                    }
                }
            }
        }
    }

    /// The option he pressed among those drawn, when he pressed one: else his answer (his words, a person) shows as
    /// the one busy pill.
    private var pressedChoice: String? {
        guard pressedPerson == nil, let options = pressed?.request.options, options.count == 1,
            shown.contains(where: { $0.id == options[0] })
        else { return nil }
        return options[0]
    }

    /// The person row he tapped, when his answer names one drawn on the card: that row works and turns green, never
    /// the naming option's button below it.
    private var pressedPerson: String? {
        guard let ref = pressed?.request.person, people.contains(where: { $0.ref == ref }) else { return nil }
        return ref
    }

    private func press(of person: Party) -> PartyPick.Press {
        guard let pressed, person.ref == pressedPerson else { return .rest }
        switch life.state(of: pressed.key) {
        case .succeeded: return .done
        case .failed: return .rest
        case .idle, .running: return .working
        }
    }

    /// One answer's button: at rest, or, once he pressed an answer, the pressed one working, then green with Life's
    /// word (only on Life's say-so), and every other dimmed and off until it is over.
    @ViewBuilder private func answerButton(
        _ choice: Choice, kind: PillStyle.Kind, size: PillStyle.Size, isHalf: Bool = false
    ) -> some View {
        if let pressed, case .option(let id) = choice.id, id == pressedChoice {
            pressedButton(pressed, kind: kind, size: size)
        } else {
            Button(action: choice.run) { words(choice, isTile: size == .tile, isHalf: isHalf) }.buttonStyle(
                .pill(kind, size: size)
            )
            .zoomSource(choice.sheet, in: sheetZoom)
            .opacity(pressed == nil ? 1 : 0.35).disabled(pressed != nil)
        }
    }

    /// The answer he pressed, in place: "Saving…" with the spinner while Life works, then green with Life's word.
    private func pressedButton(_ pressed: Taken, kind: PillStyle.Kind, size: PillStyle.Size) -> some View {
        let state = life.state(of: pressed.key)
        return Button {
        } label: {
            if case .succeeded(let proof, _) = state {
                HStack(spacing: Metrics.Spacing.s) {
                    Image(systemName: "checkmark")
                    Text(pressed.doneWord(proof).trimmingCharacters(in: CharacterSet(charactersIn: ".")))
                }
            } else {
                WorkingWords(words: pressed.isStart ? "Starting…" : "Saving…", key: pressed.key)
            }
        }
        .buttonStyle(.pill(state.isDone(isSend: false) ? .done : kind, size: size, isBusy: state.isRunning))
        .motion(Motion.standard, value: state.isDone(isSend: false))
    }

    /// One tap answers; an option that names someone opens "Same as…", and a name card's "Organization" its create sheet.
    private func tap(_ option: Check.Option) {
        switch sheet(of: option) {
        case .create(_, let asOrganization)?: if let name = check.askedName { create(name, asOrganization) }
        case .people?: sameAs()
        case nil:
            if let request = check.answer(option) { return answer(request) }
            // A note, or what this build doesn't know yet: his own words go back, never a dead button.
            if [.note, .unknown].contains(option.takes), check.takesOwnWords {
                input.option = option.takes == .note ? option.id : nil
                input.isWritingOwnWords = true
            } else {
                life.show(.init(words: "This version of the app can’t answer that yet.", undo: nil, isDone: false))
            }
        }
    }
}

/// A running answer's words, "Still working…" once the Mac has said nothing for 8 s (`LifeStore.working`).
struct WorkingWords: View {
    let words: String
    let key: LifeStore.ActionKey
    @Environment(LifeStore.self) private var life

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let shown = life.working(words, of: key, at: context.date)
            Text(shown).contentTransition(.opacity).motion(Motion.standard, value: shown)
        }
    }
}
