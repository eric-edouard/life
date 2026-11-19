import LifeConnector
import SwiftUI

/// One check as a card, whatever its kind: its look comes from what it holds (a draft, an evidence quote, clips, a
/// group), never from a kind of its own. His taps leave through `answer`; this view keeps nothing of the answer.
struct CheckCard: View {
    let check: Check
    /// The runtime of the agent that asked, when the card's matter has one.
    let runtimeName: RuntimeName?
    let openMatter: (String) -> Void
    /// His answer to the guess a draft rests on (`check.confirm`), sent at once; the card stays as it is.
    let confirm: (AnswerRequest) -> Void
    /// What he has typed or opened on this card: kept by the screen, so folding the phone keeps it.
    @Binding var input: CardInput

    /// The card's context shows in a region of its own, so its "Why" row goes: `CardArrangement` decides.
    @Environment(\.isContextBeside) private var isContextBeside

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                meta
                chips
                Text(check.title).font(.cardHeadline).foregroundStyle(Palette.fg).fixedSize(
                    horizontal: false, vertical: true
                )
                .accessibilityAddTraits(.isHeader)
                Text(check.question).font(.cardQuestion).foregroundStyle(Palette.fg).lit()
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 4)
                if input.isWritingOwnWords { ownWords } else { content }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 16)
            .readingWidth()
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
    }

    // MARK: Top

    @ViewBuilder private var meta: some View {
        if let deadline = check.deadline {
            Caps("By \(deadline.formatted(.dateTime.weekday(.abbreviated).hour().minute()))", color: Palette.flag)
        }
    }

    private var chips: some View {
        HStack(spacing: 8) {
            Label(check.askerName(runtime: runtimeName), systemImage: "sparkle")
                .labelStyle(.titleAndIcon).font(.chip)
                .foregroundStyle(Palette.ai).padding(.horizontal, 14).frame(minHeight: 40)
                .background(Color.fillTint, in: .capsule).lineLimit(1)
            if let matter = check.matter {
                Button {
                    openMatter(matter.id)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "list.bullet.indent").accessibilityHidden(true)
                        Text(matter.name).lineLimit(1)
                        Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(
                            Palette.muted
                        )
                        .accessibilityHidden(true)
                    }
                    .font(.chip).foregroundStyle(Palette.fg)
                    .padding(.horizontal, 14).frame(minHeight: 40).background(Color.fillTint, in: .capsule)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Matter: \(matter.name)")
            }
        }
    }

    // MARK: Body

    @ViewBuilder private var content: some View {
        ForEach(check.confirm ?? []) { guess in
            RowGroup {
                ConfirmRow(check: guess) { option in
                    if let request = guess.answer(option) { confirm(request) }
                }
            }
        }
        if let draft = check.draft { DraftBlock(draft: draft) }
        if let evidence = check.evidence { EvidenceBlock(evidence: evidence) }
        if !check.clips.isEmpty { ClipBlock(clips: check.clips) }
        if let line = ridesOnLine {
            Text(line).font(.small).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
        }
        if !isContextBeside, let context = check.context, !context.isEmpty {
            DisclosureGroup(isExpanded: $input.showsWhy) {
                Text(context).font(.body15).foregroundStyle(Palette.muted).frame(
                    maxWidth: .infinity, alignment: .leading
                )
                .padding(.top, 6).fixedSize(horizontal: false, vertical: true)
            } label: {
                Text(whyLabel).font(.lead).foregroundStyle(Palette.muted)
            }
            .tint(Palette.muted)
            .padding(.vertical, 12)
            .overlay(alignment: .top) { Hairline() }
            .overlay(alignment: .bottom) { Hairline() }
        }
    }

    /// "14 facts and 2 matters rest on it", for the kinds whose answer changes what Life holds; none when nothing does.
    private var ridesOnLine: String? {
        guard let rides = check.ridesOn, [.name, .guessedPerson, .voice, .ending].contains(check.group) else {
            return nil
        }
        let parts = [(rides.observations, "fact"), (rides.matters, "matter")].filter { $0.0 > 0 }
            .map { "\($0.0) \($0.1)\($0.0 == 1 ? "" : "s")" }
        guard !parts.isEmpty else { return nil }
        let count = rides.observations + rides.matters
        return parts.joined(separator: " and ") + (count == 1 ? " rests on it" : " rest on it")
    }

    private var whyLabel: String {
        switch check.group {
        case .contactsCard, .newMatter: "Where Life found it"
        case .ending: "What rests on it"
        case .voice: "Why Life thinks so"
        default: "Why, and what it rests on"
        }
    }

    private var ownWords: some View {
        VStack(alignment: .leading, spacing: 10) {
            Caps(check.group == .newMatter ? "Your goal" : "Your answer")
            TextField(
                check.group == .newMatter ? "The goal" : "Say it in your own words", text: $input.words, axis: .vertical
            )
            .font(.quote).foregroundStyle(Palette.fg).lineLimit(3...8)
            .padding(16).background(Palette.card, in: .rect(cornerRadius: Metrics.Radius.passage))
            Text(
                check.group == .newMatter
                    ? "It becomes the matter's goal. Then Start or Dismiss." : "Your words go to the agent as they are."
            ).font(.small).foregroundStyle(Palette.faint)
        }
    }
}

// MARK: Bodies

/// The exact message he approves: who, where, what it answers, the words.
struct DraftBlock: View {
    let draft: Check.Draft

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
                .padding(.horizontal, 14).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.fillTint, in: .rect(cornerRadius: Metrics.Radius.tile))
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
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .paperBox()
        .accessibilityElement(children: .combine)
    }
}

/// The words a card rests on, and where they came from.
private struct EvidenceBlock: View {
    let evidence: Check.Evidence

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("“\(evidence.quote)”").font(.quote).foregroundStyle(Palette.fg)
                .fixedSize(horizontal: false, vertical: true)
            Text(evidence.from).font(.small).foregroundStyle(Palette.muted)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .paperBox()
        .accessibilityElement(children: .combine)
    }
}

/// The clips of a voice to name, each played from the server's cut of its recording.
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
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .paperBox()
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
