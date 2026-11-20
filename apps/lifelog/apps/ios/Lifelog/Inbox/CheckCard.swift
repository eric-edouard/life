import LifeConnector
import SwiftUI

/// One check as the Ask panel, whatever its kind: the question first, nothing above it; the thing it is about on `tile`,
/// which hugs what it holds and scrolls when that is taller than the room; one row under it (the matter, and the one
/// link, to its context sheet); then, at the bottom, its answers. Its look
/// comes from what the check holds (a draft, a sentence, clips, a group), never from a kind of its own. His taps
/// leave through `answer`; this view keeps nothing of the answer. At an accessibility text size the whole panel scrolls.
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
    /// "I dropped this whole project", the one ready line over his own words when the card's matter has a project
    /// underway: parks it.
    var dropProject: (() -> Void)?
    /// Where it stands among the asks paged beside it (its index, how many); nil alone.
    var page: (current: Int, total: Int)?

    /// The card's context shows in a region of its own, so its matter row and "Why" link go: `CardArrangement` decides.
    @Environment(\.isContextBeside) private var isContextBeside
    @Environment(LifeStore.self) private var life
    @Environment(\.dynamicTypeSize) private var typeSize
    @FocusState private var isWriting: Bool
    /// Whether the link found room beside the matter; else it moves to the deadline's line.
    @State private var isLinkBesideMatter = true

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                ScrollView {
                    VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                        question
                        tile(scrolls: false)
                        matterRow
                        actions
                    }
                    .padding(.horizontal, Metrics.Spacing.s).padding(.vertical, Metrics.Spacing.m).readingWidth()
                }
            } else {
                VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                    question
                    tile(scrolls: true)
                    matterRow
                    Spacer(minLength: 0)
                    if let page {
                        PagerDots(current: page.current, total: page.total).frame(
                            maxWidth: .infinity, alignment: .trailing)
                    }
                    actions
                }
                .padding(.horizontal, Metrics.Spacing.s).padding(.top, Metrics.Spacing.m)
                .padding(.bottom, Metrics.Spacing.s).readingWidth()
            }
        }
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

    /// The thing on `tile`: his own words while he writes them, else what the ask is about; no tile when it has nothing.
    /// The tile hugs the thing and scrolls (from its start) only when the thing is taller than the room.
    @ViewBuilder private func tile(scrolls: Bool) -> some View {
        if input.isWritingOwnWords || hasThing {
            let thing = VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                if input.isWritingOwnWords { ownWords } else { content }
            }
            .padding(Metrics.Spacing.m).frame(maxWidth: .infinity, alignment: .leading)
            if scrolls {
                ViewThatFits(in: .vertical) {
                    thing.background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
                    ScrollView { thing }.scrollBounceBehavior(.basedOnSize)
                        .scrollEdgeEffectStyle(.soft, for: .vertical)
                        .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
                        .clipShape(.rect(cornerRadius: Metrics.Radius.passage))
                }
            } else {
                thing.background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
            }
        }
    }

    @ViewBuilder private var content: some View {
        if let draft = check.draft {
            DraftBlock(
                draft: draft, identity: check.networkIdentity, isGuess: check.isRecipientGuessed, isBoxed: false)
        }
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
        .font(.quote).foregroundStyle(Palette.fg).lineLimit(3...8).focused($isWriting)
        .onAppear { isWriting = true }
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

    private var actions: some View {
        CheckActions(
            check: check, input: $input, isBusy: isBusy,
            links: isRowShown && isLinkBesideMatter ? Array(askLinks.dropFirst()) : askLinks, answer: answer,
            sameAs: sameAs, create: create
        )
        .padding(.bottom, Metrics.Spacing.xs)
    }
}

private struct LinkBesideMatter: PreferenceKey {
    static let defaultValue = true
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = nextValue() }
}
