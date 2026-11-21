import LifeConnector
import SwiftUI

/// One check as the Ask panel, whatever its kind, one scroll view (decision 97): the question first, under the screen's
/// title when it has one; the thing it is about on `tile`, at its full length; one row under it (the matter, and the one
/// link, to its context sheet); then its answers, floating over the foot. Its look comes from what the check holds (a
/// draft, a sentence, clips, a group), never from a kind of its own. His taps leave through `answer`; this view keeps
/// nothing of the answer.
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
    var dropProject: (() -> Void)?
    /// Where it stands among the asks paged beside it (its index, how many); nil alone.
    var page: (current: Int, total: Int)?
    /// The screen's title over its question (the Inbox's alone), in the card's own top bar so the card scrolls under it.
    var title: ScreenTitle?

    /// The card's context shows in a region of its own, so its matter row and "Why" link go: `CardArrangement` decides.
    @Environment(\.isContextBeside) private var isContextBeside
    @Environment(LifeStore.self) private var life
    @Environment(\.dynamicTypeSize) private var typeSize
    @FocusState private var isWriting: Bool
    /// Whether the link found room beside the matter; else it moves to the deadline's line.
    @State private var isLinkBesideMatter = true

    var body: some View {
        // One scroll view, nothing scrolling inside it (decision 97); the answers float over its foot in the system's
        // bar, so its soft edge shows under them and the content's end scrolls clear. At an accessibility text size they
        // close the content instead, so the bar never covers the screen.
        let isAnswersBarred = !typeSize.isAccessibilitySize
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                question
                tile
                beingFixed
                matterRow
                if !input.isWritingOwnWords { RefusedAnswer(check: check) }
                if !isAnswersBarred { answers }
            }
            .padding(.horizontal, Metrics.Spacing.s).padding(.vertical, Metrics.Spacing.m).readingWidth()
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaBar(edge: .bottom, spacing: 0) {
            if isAnswersBarred {
                answers.padding(.horizontal, Metrics.Spacing.s).padding(.bottom, Metrics.Spacing.s).readingWidth()
            }
        }
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .screenTitle(title?.name, state: title?.state)
        .sheet(isPresented: $input.showsContext) {
            ContextSheet(
                title: check.contextLinkTitle ?? "", markdown: check.context ?? "", lifeLinks: check.lifeLinks ?? [],
                appLink: check.links.first.flatMap(URL.init(string:)), appName: runtimeName?.name)
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
        check.draft != nil || !(check.needs ?? []).isEmpty || !check.clips.isEmpty || check.said != nil
            || identity != nil || check.contactsCard != nil || (check.group == .newMatter && check.goal != nil)
    }

    /// A guessed person with the chat the network shows them in: that is the thing.
    private var identity: Check.NetworkIdentity? { check.group == .guessedPerson ? check.networkIdentity : nil }

    /// The thing on `tile`: his own words while he writes them, else what the ask is about, at its full length (the card
    /// scrolls, never the tile); no tile when it has nothing.
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
        DraftBlock(check: check, isBoxed: false)
        if let needs = check.needs, !needs.isEmpty { NeedsBlock(needs: needs) }
        switch check.group {
        case .ending: EndingBlock(said: check.said, since: check.since)
        case .newMatter:
            NewMatterBlock(goal: check.goal, said: check.said) {
                input.words = check.goal ?? ""
                input.isWritingOwnWords = true
            }
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
            Button("I dropped this whole project") {
                input.isWritingOwnWords = false
                dropProject()
            }
            .buttonStyle(.pill(.quiet, size: .compact)).fixedSize()
        }
        TextField(
            check.group == .newMatter ? "The goal" : "Say it in your own words", text: $input.words, axis: .vertical
        )
        .font(.quote).foregroundStyle(Palette.fg).lineLimit(3...).focused($isWriting)
        .onAppear { isWriting = true }
    }

    /// His "Wrong…" the caretaker is at work on: its own line under the tile, the caretaker's words when it has them.
    @ViewBuilder private var beingFixed: some View {
        if let fixing = check.beingFixed {
            HStack(spacing: Metrics.Spacing.s) {
                StateGlyph.busy
                Text(fixing.line ?? "The caretaker is fixing this").font(.small).foregroundStyle(Palette.muted)
            }
            .appears()
        }
    }

    // MARK: The row under the thing, and the link

    /// The ask's links, by what each opens: its context, in the code's words for what it asks ("Why this reply?"), when
    /// it has one and it is not shown beside it; then "Tell the agent…" on an agent's question.
    private var askLinks: [AskLink] {
        var links: [AskLink] = []
        if !isContextBeside, let title = check.contextLinkTitle {
            links.append(AskLink(title: title) { input.showsContext = true })
        }
        if check.takesOwnWords { links.append(AskLink(title: "Tell the agent…") { input.isWritingOwnWords = true }) }
        return links
    }

    private var isRowShown: Bool {
        !input.isWritingOwnWords && !isContextBeside && (check.matter != nil || !askLinks.isEmpty)
    }

    /// The matter as a pill and, at its right, the first link; when both do not fit, the pill alone and the links move to
    /// the deadline's line above the answers.
    @ViewBuilder private var matterRow: some View {
        if isRowShown {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Metrics.Spacing.m) {
                    matterPill.fixedSize()
                    Spacer(minLength: Metrics.Spacing.m)
                    if let link = askLinks.first { TextLink(link.title, action: link.run).fixedSize() }
                }
                .preference(key: LinkBesideMatter.self, value: true)
                HStack(spacing: 0) {
                    matterPill
                    Spacer(minLength: 0)
                }
                .preference(key: LinkBesideMatter.self, value: false)
            }
            .onPreferenceChange(LinkBesideMatter.self) { isLinkBesideMatter = $0 }
        }
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

    /// Where it stands among the asks (the dots), then its answers.
    private var answers: some View {
        VStack(spacing: Metrics.Spacing.m) {
            // While a tapped push is checked, how many asks wait is not known yet: the spinner, then the dots.
            Group {
                if life.isCheckingPush {
                    Spinner(size: .small).foregroundStyle(Palette.fg)
                } else if let page {
                    PagerDots(current: page.current, total: page.total)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .motion(Motion.standard, value: life.isCheckingPush)
            actions
        }
    }

    private var actions: some View {
        CheckActions(
            check: check, input: $input, isBusy: isBusy,
            links: isRowShown && isLinkBesideMatter ? Array(askLinks.dropFirst()) : askLinks, answer: answer,
            sameAs: sameAs, create: create, wrong: wrong
        )
        .padding(.bottom, Metrics.Spacing.xs)
    }
}

private struct LinkBesideMatter: PreferenceKey {
    static let defaultValue = true
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = nextValue() }
}
