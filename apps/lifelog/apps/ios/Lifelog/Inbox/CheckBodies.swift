import LifeConnector
import UniformTypeIdentifiers
import SwiftUI

// What each ask is about, one body per field Life sends (`said`, `since`, `goal`, `networkIdentity`, `contactsCard`,
// `draft`, `evidence`), drawn on the Ask panel's `tile`. `CheckCard` picks them by what the check holds, never by its
// group's wording. A sentence's who-and-when is never dimmed; a sentence may be.

/// A sentence's words in quotes, in the body type, with each of `names` in bold.
struct NamedWords: View {
    let said: Check.Said
    let names: [String]

    @Environment(\.dynamicTypeSize) private var size

    var body: some View {
        var words = AttributedString(said.text)
        for range in said.text.ranges(ofNames: names) {
            if let shown = Range(range, in: words) { words[shown].font = TypeStep.bodyBold.font(at: size) }
        }
        return Text(AttributedString("“") + words + AttributedString("”")).font(.body15)
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

/// What he needs in hand to do the step, each fact a row: a muted glyph, the fact, and its one press (copy, or open a
/// page, by his tap only). Which rows a need draws is `Need.rows`; a copy shows its check and "Copied <what>" for 2 s.
struct NeedsBlock: View {
    let needs: [Check.Need]

    @Environment(\.openURL) private var openURL
    /// The row he just copied, and what went on the pasteboard.
    @State private var copied: (row: Int, text: String)?

    private var rows: [NeedRow] { needs.flatMap(\.rows) }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                HStack(alignment: .center, spacing: Metrics.Spacing.m) {
                    Image(systemName: Self.symbol(row.glyph)).font(.lead).foregroundStyle(Palette.muted)
                        .frame(width: Metrics.FlatRow.slot).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                        Text(row.text).font(row.isFigure ? .rowFigure : .body15).foregroundStyle(Palette.fg)
                            .fontWeight(row.isFigure ? .semibold : nil).lineLimit(2)
                        if let detail = copied?.row == index ? "Copied \(copied?.text ?? "")" : row.detail {
                            // A link's host in full, on as many lines as it takes: the trust boundary.
                            Text(detail).font(.small).foregroundStyle(Palette.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 0)
                    if let action = row.action { button(action, row: index) }
                }
                .frame(minHeight: Metrics.tapTarget)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .motion(Motion.standard, value: copied?.row)
    }

    @ViewBuilder private func button(_ action: NeedRow.Action, row: Int) -> some View {
        switch action {
        case .copy(let text, let label):
            RoundIconButton(symbol: "doc.on.doc", label: label, isDone: copied?.row == row) {
                // This phone only: an account number never rides Universal Clipboard to his other devices.
                UIPasteboard.general.setItems([[UTType.plainText.identifier: text]], options: [.localOnly: true])
                copied = (row, text)
                AccessibilityNotification.Announcement("Copied \(text)").post()
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    if copied?.row == row { copied = nil }
                }
            }
        case .open(let url, let label):
            RoundIconButton(symbol: "arrow.up.right", label: label) { openURL(url) }
        }
    }

    private static func symbol(_ glyph: NeedRow.Glyph) -> String {
        switch glyph {
        case .bank: "building.columns"
        case .card: "creditcard"
        case .person: "person"
        case .amount: "banknote"
        case .link: "link"
        case .note: "note.text"
        }
    }
}

/// Life's outcome on a step it sees done itself, in one line above the answers: seen, or not found yet. Life's
/// own words win ("Paid, 4,500 THB"); the phone's are plain fallbacks that never name Life (`voice.md`).
struct DoneSeenLine: View {
    let doneSeen: Check.DoneSeen?

    var body: some View {
        if let doneSeen, let shown = Self.shown(doneSeen.state) {
            HStack(spacing: Metrics.Spacing.s) {
                shown.glyph
                Text(doneSeen.line ?? shown.words).font(.small).foregroundStyle(shown.color)
            }
            .frame(maxWidth: .infinity, alignment: .leading).appears()
            .accessibilityElement(children: .combine)
        }
    }

    private static func shown(_ state: Check.DoneSeen.State) -> (glyph: StateGlyph, words: String, color: Color)? {
        switch state {
        case .seen: (.ok, "Done.", Palette.ok)
        case .notFound: (.flag, "Not found yet.", Palette.flag)
        // Looking is the busy answer itself (`CheckActions`), never a second line.
        case .looking, .unknown: nil
        }
    }
}
