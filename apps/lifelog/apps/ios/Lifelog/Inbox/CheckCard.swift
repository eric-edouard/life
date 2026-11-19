import LifeConnector
import SwiftUI

/// One check as the Ask panel, whatever its kind: the question first, nothing above it; the thing it is about on `tile`,
/// which takes every point left and scrolls; one row under it (the matter, and the one link); then its answers. Its look
/// comes from what the check holds (a draft, an evidence quote, clips, a group), never from a kind of its own. His taps
/// leave through `answer`; this view keeps nothing of the answer. At an accessibility text size the whole panel scrolls.
struct CheckCard: View {
    let check: Check
    /// The runtime of the agent that asked, when the card's matter has one.
    let runtimeName: RuntimeName?
    let openMatter: (String) -> Void
    /// His answer to the guess a draft rests on (`check.confirm`), sent at once; the card stays as it is.
    let confirm: (AnswerRequest) -> Void
    /// What he has typed or opened on this card: kept by the screen, so folding the phone keeps it.
    @Binding var input: CardInput
    /// His answer is being sent or saved.
    let isBusy: Bool
    let answer: (AnswerRequest) -> Void
    let sameAs: () -> Void

    /// The card's context shows in a region of its own, so its matter row and "Why" link go: `CardArrangement` decides.
    @Environment(\.isContextBeside) private var isContextBeside
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
                    actions
                }
                .padding(.horizontal, Metrics.Spacing.s).padding(.top, Metrics.Spacing.m)
                .padding(.bottom, Metrics.Spacing.s).readingWidth()
            }
        }
        .sheet(isPresented: $input.showsWhy) {
            WhySheet(
                title: link?.title ?? "Why?", context: check.context, link: check.links.first, runtime: runtimeName
            )
            .sheetStack()
        }
    }

    private var question: some View {
        Text(check.question).font(.cardQuestion).foregroundStyle(Palette.fg)
            .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Under the question

    private var hasThing: Bool {
        !(check.confirm ?? []).isEmpty || check.draft != nil || check.evidence != nil || !check.clips.isEmpty
    }

    /// The thing on `tile`: his own words while he writes them, else what the ask is about; no tile when it has nothing.
    @ViewBuilder private func tile(scrolls: Bool) -> some View {
        if input.isWritingOwnWords || hasThing {
            let thing = VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                if input.isWritingOwnWords { ownWords } else { content }
            }
            .padding(Metrics.Spacing.m).frame(maxWidth: .infinity, alignment: .leading)
            if scrolls {
                ScrollView { thing }.scrollBounceBehavior(.basedOnSize).scrollEdgeEffectStyle(.soft, for: .vertical)
                    .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
                    .clipShape(.rect(cornerRadius: Metrics.Radius.passage))
            } else {
                thing.background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
            }
        } else if scrolls {
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder private var content: some View {
        ForEach(check.confirm ?? []) { guess in
            RowGroup {
                QuestionRow(check: guess) { option in
                    if let request = guess.answer(option) { confirm(request) }
                }
            }
        }
        if let draft = check.draft { DraftBlock(draft: draft, isBoxed: false) }
        if let evidence = check.evidence { EvidenceBlock(evidence: evidence) }
        if !check.clips.isEmpty { ClipBlock(clips: check.clips) }
    }

    private var ownWords: some View {
        TextField(
            check.group == .newMatter ? "The goal" : "Say it in your own words", text: $input.words, axis: .vertical
        )
        .font(.quote).foregroundStyle(Palette.fg).lineLimit(3...8).focused($isWriting)
        .onAppear { isWriting = true }
    }

    // MARK: The row under the thing, and the link

    private var hasWhy: Bool { !isContextBeside && (!(check.context ?? "").isEmpty || !check.links.isEmpty) }
    /// An agent's open question: his words go to the agent.
    private var isAgentQuestion: Bool { check.takesOwnWords && check.draft == nil }

    /// The ask's one link, by what it opens.
    private var link: AskLink? {
        if hasWhy { return AskLink(title: check.draft == nil ? "Why?" : "Why this reply?") { input.showsWhy = true } }
        if isAgentQuestion { return AskLink(title: "Tell the agent…") { input.isWritingOwnWords = true } }
        return nil
    }

    private var isRowShown: Bool {
        !input.isWritingOwnWords && !isContextBeside && (check.matter != nil || link != nil)
    }

    /// The matter as a pill and, at its right, the link; when both do not fit, the pill alone and the link moves to the
    /// deadline's line above the answers.
    @ViewBuilder private var matterRow: some View {
        if isRowShown {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Metrics.Spacing.m) {
                    matterPill.fixedSize()
                    Spacer(minLength: Metrics.Spacing.m)
                    if let link { TextLink(link.title, action: link.run).fixedSize() }
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
            InlinePill(name: matter.name, isAgent: check.agentName(runtime: runtimeName) != nil) {
                openMatter(matter.id)
            }
        }
    }

    private var actions: some View {
        CheckActions(
            check: check, input: $input, isBusy: isBusy,
            link: isRowShown && isLinkBesideMatter ? nil : link, hasOwnWordsAnswer: isAgentQuestion && hasWhy,
            answer: answer, sameAs: sameAs
        )
        .padding(.bottom, Metrics.Spacing.xs)
    }
}

private struct LinkBesideMatter: PreferenceKey {
    static let defaultValue = true
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = nextValue() }
}

/// What is behind an ask: why Life asked, and the way into the asker's own app.
private struct WhySheet: View {
    let title: String
    let context: String?
    let link: String?
    let runtime: RuntimeName?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                SheetHeader(title: title) { dismiss() }
                if let context, !context.isEmpty {
                    Text(context).font(.body15).foregroundStyle(Palette.fg).fixedSize(
                        horizontal: false, vertical: true)
                }
                if let url = link.flatMap(URL.init(string:)) {
                    TextLink("Open in \(runtime?.name ?? "its app")", isOutward: true) { openURL(url) }
                }
            }
            .padding(Metrics.gutter).readingWidth()
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Palette.sheet)
        .presentationDetents([.medium, .large])
    }
}

// MARK: Bodies

/// The exact message he approves: who, where, what it answers, the words.
struct DraftBlock: View {
    let draft: Check.Draft
    /// On paper of its own (after an answer); in an ask it sits on the thing's `tile` with no box.
    var isBoxed = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("To \(draft.to), on \(ActionCopy.channel(draft.channel))", systemImage: "bubble.left")
                .font(.body15).foregroundStyle(Palette.muted)
            if let subject = draft.subject {
                Text(subject).font(.buttonLabel).foregroundStyle(Palette.fg)
            }
            if let quoted = draft.quoted {
                VStack(alignment: .leading, spacing: 2) {
                    Label("Answering \(quoted.sender)’s message", systemImage: "arrowshape.turn.up.left")
                        .font(.buttonLabel).foregroundStyle(Palette.fg)
                    Text(quoted.text).font(.body15).foregroundStyle(Palette.muted).lineLimit(3)
                }
                .padding(.horizontal, Metrics.Spacing.m).padding(.vertical, Metrics.Spacing.m)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.sheet, in: .rect(cornerRadius: Metrics.Radius.tile))
            }
            if let text = draft.text {
                Text(text).font(.quote).foregroundStyle(Palette.fg).fixedSize(
                    horizontal: false, vertical: true)
            }
            if let reaction = draft.reaction { Text(reaction).font(.system(size: 34)) }
            if let file = draft.file {
                Label("\(file.name) · \(file.size.formatted(.byteCount(style: .file)))", systemImage: "doc")
                    .font(.body15).foregroundStyle(Palette.fg)
            }
        }
        .padding(isBoxed ? Metrics.Spacing.l : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isBoxed ? Palette.paper : .clear, in: .rect(cornerRadius: Metrics.Radius.passage))
        .accessibilityElement(children: .combine)
    }
}

/// The words a card rests on, and where they came from.
private struct EvidenceBlock: View {
    let evidence: Check.Evidence

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            Text(evidence.from).font(.small).foregroundStyle(Palette.muted)
            Text("“\(evidence.quote)”").font(.quote).foregroundStyle(Palette.fg)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// The clips of a voice to name, on the thing's tile, each played from the server's cut of its recording.
private struct ClipBlock: View {
    let clips: [Check.Clip]

    @Environment(PlaybackStore.self) private var playback
    @State private var index = 0
    /// Fetching the audio, or why it could not be had.
    @State private var isFetching = false
    @State private var failed = false
    /// The clip being fetched: cancelled when the card goes, so it never plays after.
    @State private var fetch: Task<Void, Never>?

    var body: some View {
        let clip = clips[min(index, clips.count - 1)]
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 14) {
                Button {
                    toggle(clip)
                } label: {
                    Group {
                        if isFetching {
                            ProgressView().tint(Palette.on)
                        } else {
                            Image(systemName: playback.isPlaying ? "stop.fill" : "play.fill").font(.system(size: 17))
                        }
                    }
                    .foregroundStyle(Palette.on).frame(width: 48, height: 48).background(Palette.fg, in: .circle)
                }
                .buttonStyle(.plain).disabled(isFetching)
                .accessibilityLabel(isFetching ? "Loading the clip" : playback.isPlaying ? "Stop" : "Play the clip")
                VStack(alignment: .leading, spacing: 6) {
                    Text("“\(clip.text)”").font(.quote).foregroundStyle(Palette.fg)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(caption(clip)).font(.monoTime).foregroundStyle(Palette.muted)
                    if failed {
                        Text("Couldn't load the clip. Tap play to try again.").font(.small).foregroundStyle(
                            Palette.flag)
                    }
                }
            }
            if clips.count > 1 {
                TextLink("Another clip") {
                    playback.stop(); index = (index + 1) % clips.count
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onDisappear {
            fetch?.cancel()
            playback.stop()
        }
    }

    private func caption(_ clip: Check.Clip) -> String {
        let seconds = clip.audio.map { Int(($0.end - $0.start).rounded()) } ?? 0
        let length = "\(seconds / 60):" + String(format: "%02d", seconds % 60)
        return "\(length) · \(min(index, clips.count - 1) + 1) of \(clips.count) clip\(clips.count == 1 ? "" : "s")"
    }

    private func toggle(_ clip: Check.Clip) {
        if playback.isPlaying { return playback.stop() }
        failed = false
        guard let audio = clip.audio, let job = UUID(uuidString: audio.jobId) else { return failed = true }
        isFetching = true
        fetch = Task {
            let file = await ClipAudio.file(job)
            isFetching = false
            guard !Task.isCancelled else { return }
            guard let file else { return failed = true }
            playback.play(file, from: audio.start, for: audio.end - audio.start)
        }
    }
}
