import LifeConnector
import SwiftUI

// What each ask is about, one body per field Life sends (`said`, `since`, `goal`, `networkIdentity`, `contactsCard`,
// `draft`, `evidence`), drawn on the Ask panel's `tile`. `CheckCard` picks them by what the check holds, never by its
// group's wording. A sentence's who-and-when is never dimmed; a sentence may be.

/// A sentence's words with each of `names` in bold: in the `regular` step, the names in the `bold` one.
struct NamedWords: View {
    let said: Check.Said
    let names: [String]
    var regular = TypeStep.quote
    var bold = TypeStep.quoteBold
    var isQuoted = true

    @Environment(\.dynamicTypeSize) private var size

    var body: some View {
        var words = AttributedString(said.text)
        for range in said.text.ranges(ofNames: names) {
            if let shown = Range(range, in: words) { words[shown].font = bold.font(at: size) }
        }
        return Text(isQuoted ? AttributedString("“") + words + AttributedString("”") : words).font(regular)
    }
}

/// A sentence as it was said: who, to whom, where and when above, its words under, a name asked about in bold.
struct SaidBlock: View {
    let said: Check.Said
    var names: [String] = []

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            let line = said.line(channelName: Channel.name)
            if !line.isEmpty { Text(line).font(.small).foregroundStyle(Palette.muted) }
            NamedWords(said: said, names: names).foregroundStyle(Palette.fg)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// A name nobody is: the sentence with the name in bold, who to whom and when above; when it was heard, its clip plays
/// from a 28 Play at the right of the words.
struct NameBlock: View {
    let said: Check.Said?
    let names: [String]
    let clip: Check.Clip?

    var body: some View {
        if let clip, let audio = clip.audio, let job = UUID(uuidString: audio.jobId) {
            SpokenWords(
                text: clip.text, words: clip.words, job: job, start: audio.start, end: audio.end, style: .inline,
                emphasis: names, caption: said?.line(channelName: Channel.name)
            )
            .font(.quote)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if let said {
            SaidBlock(said: said, names: names)
        }
    }
}

/// A voice to name: when it was heard above the words and its length at the right with the next clip; the clip's words
/// lit as they are said, and the clips playing on one after another.
struct VoiceBlock: View {
    let clips: [Check.Clip]

    @Environment(PlaybackStore.self) private var playback
    @State private var index = 0
    @State private var autoplay = false

    private var clip: Check.Clip { clips[min(index, clips.count - 1)] }
    private var job: UUID? { clip.audio.flatMap { UUID(uuidString: $0.jobId) } }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            header
            Group {
                if let audio = clip.audio, let job {
                    SpokenWords(
                        text: clip.text, words: clip.words, job: job, start: audio.start, end: audio.end,
                        autoplay: autoplay, onEnded: { move(to: index + 1, playing: true) })
                } else {
                    WholeWords("“\(clip.text)”").foregroundStyle(Palette.fg)
                }
            }
            .font(.quote)
            .id(index).transition(.opacity)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .motion(.easeOut(duration: 0.15), value: index)
    }

    private var header: some View {
        HStack(spacing: Metrics.Spacing.s) {
            if let at = clip.at { Text(SaidWords.day(at)).font(.small).foregroundStyle(Palette.muted) }
            Spacer(minLength: 0)
            if let length = clip.lengthText { Text(length).font(.monoTime).foregroundStyle(Palette.muted) }
            if clips.count > 1 {
                Text("\(index + 1)/\(clips.count)").font(.monoTime).foregroundStyle(Palette.muted)
                Button {
                    let wasPlaying = playback.isPlaying
                    playback.stop()
                    move(to: (index + 1) % clips.count, playing: wasPlaying)
                } label: {
                    Image(systemName: "forward.end.fill").font(.system(size: 10)).foregroundStyle(Palette.fg)
                        .frame(width: 28, height: 28).background(Color.fillTint, in: .circle)
                        .frame(minWidth: Metrics.tapTarget, minHeight: Metrics.tapTarget)
                }
                .buttonStyle(.plain).accessibilityLabel("Next clip")
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func move(to next: Int, playing: Bool) {
        guard clips.indices.contains(next) else { return }
        autoplay = playing
        index = next
    }
}

/// An ending: the step said, then what came since.
struct EndingBlock: View {
    let said: Check.Said?
    let since: Check.Said?

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            if let said { SaidBlock(said: said) }
            if let since {
                VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
                    Text("Since then").font(.small).foregroundStyle(Palette.muted)
                    SaidBlock(said: since)
                }
            }
        }
    }
}

/// A new matter: the goal Start hands the agent, with a pencil that opens it as his words, and the sentence that started it.
struct NewMatterBlock: View {
    let goal: String?
    let said: Check.Said?
    let edit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            if let goal {
                HStack(alignment: .top, spacing: Metrics.Spacing.m) {
                    VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                        Text("Goal").font(.small).foregroundStyle(Palette.muted)
                        Text(goal).font(.leadBold).foregroundStyle(Palette.fg)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    Spacer(minLength: 0)
                    RoundIconButton(symbol: "pencil", label: "Edit the goal", action: edit)
                }
            }
            if let said { SaidBlock(said: said) }
        }
    }
}

/// Who a guessed person is as their network shows them: initials with the network's mark, the name it shows (a "~":
/// only Life's guess), the number, the network, their newest message with its time, and the way into the chat.
struct PersonIdentityBlock: View {
    let identity: Check.NetworkIdentity

    @Environment(\.openURL) private var openURL

    var body: some View {
        let name = identity.shownName ?? identity.handle ?? ""
        let network = identity.network.map { Channel.name($0.lowercased()) }
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            HStack(spacing: Metrics.Spacing.m) {
                Avatar(name: name, network: identity.network?.lowercased())
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                    Text("~ \(name)").font(.leadBold).foregroundStyle(Palette.fg)
                    if let handle = identity.handle { Text(handle).font(.monoTime).foregroundStyle(Palette.muted) }
                    if let network { Text(network).font(.smallStrong).foregroundStyle(Palette.fg) }
                }
            }
            .accessibilityElement(children: .combine)
            if let newest = identity.newest, let text = newest.text {
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                    if let at = newest.at { Text(SaidWords.moment(at)).font(.small).foregroundStyle(Palette.muted) }
                    Text("“\(text)”").font(.quote).foregroundStyle(Palette.fg)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
            if let url = identity.openUrl {
                TextLink("Open in \(network ?? "its app")", isOutward: true, isMuted: false) { openURL(url) }
            }
        }
    }
}

/// A Contacts card Life cannot place: its name and numbers, and that it is from Contacts.
struct ContactsCardBlock: View {
    let card: Check.ContactsCard

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            Text(card.name).font(.leadBold).foregroundStyle(Palette.fg)
            ForEach(card.handles, id: \.self) { Text($0).font(.monoTime).foregroundStyle(Palette.muted) }
            Text("Contacts").font(.smallStrong).foregroundStyle(Palette.fg)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// The words a card rests on, and where they came from.
struct EvidenceBlock: View {
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
