import LifeConnector
import SwiftUI

/// One check as the Ask panel, whatever its kind, one full-height scroll with nothing scrolling inside it (decisions 97,
/// 98): the matter chip, then the question, the thing it is about on `tile` at full length, and the link to its context
/// under it; its answers float in the bottom bar over the scroll, whose end scrolls clear above them, unless they can
/// grow tall (people to pick, an accessibility text size): then they end the scroll. Its look comes from what the check
/// holds (a draft, a sentence, clips, a plan, a group), never from a kind of its own. His taps leave through `answer`;
/// this view keeps nothing of the answer.
struct CheckCard: View {
    let check: Check
    /// The runtime of the agent that asked, when the card's matter has one.
    let runtimeName: RuntimeName?
    let openMatter: (String) -> Void
    /// What he has typed or opened on this card: kept by the screen, so folding the phone keeps it.
    @Binding var input: CardInput
    /// His answer is being sent or saved.
    let isBusy: Bool
    let answer: (AnswerRequest) -> Void
    let sameAs: () -> Void
    /// "Create <name>" or "Organization": the create sheet, with the name he would create, set to an organization or not.
    let create: (String, _ asOrganization: Bool) -> Void
    /// "Wrong…" on a card of Life's: its sheet, hosted with the asks' sheets.
    let wrong: () -> Void
    /// "I dropped this whole project", the one ready line over his own words when the card's matter has a project
    /// underway: parks it.
    var dropProject: (project: String, run: () -> Void)?
    /// Where it stands among the asks paged beside it (its index, how many); nil alone.
    var page: (current: Int, total: Int)?

    /// The card's context shows in a region of its own, so its matter row and "Why" link go: `CardArrangement` decides.
    @Environment(\.isContextBeside) private var isContextBeside
    @Environment(LifeStore.self) private var life
    @Environment(\.dynamicTypeSize) private var typeSize
    @FocusState private var isWriting: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                if !input.isWritingOwnWords, check.matter != nil { matterPill }
                question
                tile
                beingFixed
                if !input.isWritingOwnWords, let link = contextLink { link }
                if !isAnswersInBar { answers }
            }
            .padding(.horizontal, Metrics.Spacing.s).padding(.vertical, Metrics.Spacing.m).readingWidth()
        }
        .motion(Motion.standard, value: input.isWritingOwnWords)
        .scrollBounceBehavior(.basedOnSize)
        .scrollEdgeEffectStyle(.soft, for: .vertical)
        .safeAreaBar(edge: .bottom, spacing: 0) {
            if isAnswersInBar {
                // Taller than the screen allows (a row of wide labels stacks), the bar scrolls rather than grows.
                ScrollView { answers.padding(.horizontal, Metrics.Spacing.s).readingWidth() }
                    .scrollBounceBehavior(.basedOnSize).frame(maxHeight: Metrics.answerBarMax)
            }
        }
        .sheet(item: $input.context) { context in
            ContextSheet(
                title: context.title, markdown: context.markdown, lifeLinks: context.lifeLinks,
                appLink: context.session.flatMap(URL.init(string:)), appName: runtimeName?.name)
        }
    }

    private var question: some View {
        Text(check.question).font(.cardQuestion).foregroundStyle(Palette.fg)
            .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Under the question

    /// Whether a field of the ask has a thing of its own to draw; its context is behind its link, never the thing.
    private var hasThing: Bool {
        !check.planSteps.isEmpty || check.draft != nil || !(check.needs ?? []).isEmpty || !check.clips.isEmpty
            || check.said != nil
            || identity != nil || check.contactsCard != nil
            || ([.newMatter, .yourMove].contains(check.group) && check.goal != nil)
    }

    /// A guessed person, or a same person card's guess, with the chat the network shows them in: that is the thing.
    private var identity: Check.NetworkIdentity? {
        check.group == .guessedPerson || check.group == .samePerson ? check.networkIdentity : nil
    }

    /// The thing on `tile`, at its full length: his own words while he writes them, else what the ask is about; no tile
    /// when it has nothing.
    @ViewBuilder private var tile: some View {
        if input.isWritingOwnWords || hasThing {
            VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                if input.isWritingOwnWords { ownWords } else { content }
            }
            .padding(Metrics.Spacing.m).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
        }
    }

    @ViewBuilder private var content: some View {
        if !check.planSteps.isEmpty {
            PlanBlock(
                steps: check.planSteps, agentMark: check.agentMark(runtime: runtimeName), gathered: check.gathered,
                openContext: isContextBeside ? nil : { input.context = check.ownContext })
        }
        DraftBlock(check: check, isBoxed: false)
        if !(check.needs ?? []).isEmpty {
            if let code = check.payCode { PayCodeBlock(code: code, isSaved: input.bankTrip.isCodeSaved) }
            let rows = check.shownNeedRows
            if !rows.isEmpty { NeedsBlock(rows: rows) }
        }
        switch check.group {
        case .ending: EndingBlock(said: check.said, since: check.since)
        case .newMatter:
            NewMatterBlock(goal: check.goal, said: check.said) {
                input.words = check.goal ?? ""
                input.isWritingOwnWords = true
            }
        case .yourMove: NewMatterBlock(goal: check.goal, said: check.said)
        case .name: NameBlock(said: check.said, names: check.about ?? [], clip: check.clips.first)
        default:
            if let said = check.said { SaidBlock(said: said) }
        }
        if let identity { PersonIdentityBlock(identity: identity) }
        if let card = check.contactsCard { ContactsCardBlock(card: card) }
        if check.group == .voice, !check.clips.isEmpty { VoiceBlock(clips: check.clips) }
    }

    @ViewBuilder private var ownWords: some View {
        if let dropProject, check.group != .newMatter {
            // Busy until Life says; it leaves once the project is parked, and a failure shows under it.
            let state = life.state(of: .project(dropProject.project))
            Button(state.isRunning ? "Parking…" : "I dropped this whole project", action: dropProject.run)
                .buttonStyle(.pill(.quiet, size: .compact, isBusy: state.isRunning)).fixedSize()
                .disabled(state.isRunning)
            if case .failed(let failure, _) = state {
                Text(failure.reason).font(.small).foregroundStyle(Palette.flag)
            }
        }
        DictationField(
            prompt: check.group == .newMatter
                ? "The goal"
                : check.draft != nil ? "\(check.tellTitle.dropLast()) what to change…" : "Say it in your own words",
            text: $input.words, axis: .vertical, focused: $isWriting
        )
        .font(.quote).foregroundStyle(Palette.fg).lineLimit(3...8)
        .onAppear { isWriting = true }
    }

    /// His "Wrong…" the caretaker is at work on, under the tile: the caretaker's open question as a chip that opens its
    /// context when it has one, else its line with the spinner.
    @ViewBuilder private var beingFixed: some View {
        if let context = check.fixContext {
            QuietChip(context.title, symbol: "questionmark.circle") { input.context = context }.appears()
        } else if let fixing = check.beingFixed {
            HStack(spacing: Metrics.Spacing.s) {
                StateGlyph.busy
                Text(fixing.line ?? "The caretaker is fixing this").font(.small).foregroundStyle(Palette.muted)
            }
            .appears()
        }
    }

    // MARK: The matter, the link, the answers

    /// The link to its context, in the code's words for what it asks ("Why this reply?"), under the thing it explains;
    /// none when the context shows beside the card, or when a plan's source chip already opens it (one way to it).
    private var contextLink: QuietChip? {
        guard !isContextBeside, check.gathered == nil || check.planSteps.isEmpty, let title = check.contextLinkTitle
        else { return nil }
        return QuietChip(title, symbol: "questionmark.circle") { input.context = check.ownContext }
    }

    @ViewBuilder private var matterPill: some View {
        if let matter = check.matter {
            InlinePill(
                name: matter.name, agentMark: check.agentMark(runtime: runtimeName),
                isImportant: life.isImportant(matter.id, as: matter.important)
            ) {
                openMatter(matter.id)
            }
        }
    }

    /// Answers that can grow taller than a bar should be (people to pick, quiet answers past one row, a refused answer,
    /// an accessibility text size) end the scroll.
    private var isAnswersInBar: Bool {
        guard !typeSize.isAccessibilitySize, CheckActions.fitsBar(check) else { return false }
        // A refused answer stands above the answers, with what was written since: it reads in the page.
        if case .failed = life.state(of: .answer(ref: check.ref)) { return false }
        return true
    }

    /// The pager's dots (a spinner while a tapped push is checked: how many asks wait is not known yet), then the
    /// answers.
    private var answers: some View {
        VStack(spacing: Metrics.Spacing.m) {
            Group {
                if life.isCheckingPush {
                    Spinner(size: .small).foregroundStyle(Palette.fg)
                } else if let page {
                    PagerDots(current: page.current, total: page.total)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .motion(Motion.standard, value: life.isCheckingPush)
            CheckActions(
                check: check, input: $input, isBusy: isBusy, answer: answer, sameAs: sameAs, create: create,
                wrong: wrong
            )
        }
        .padding(.bottom, Metrics.Spacing.s)
    }
}
