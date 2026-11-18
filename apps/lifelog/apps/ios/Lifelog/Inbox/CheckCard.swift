import LifeConnector
import SwiftUI

/// One check as a card, whatever its kind: its look comes from what it holds (a draft, an evidence quote, clips, a
/// group), never from a kind of its own. His taps leave through `answer`; this view keeps nothing of the answer.
struct CheckCard: View {
    let check: Check
    let position: Int
    let total: Int
    /// The runtime of the agent that asked, when the card's matter has one.
    let provider: Provider?
    let answer: (AnswerRequest) -> Void
    let openMatter: (String) -> Void

    @Environment(\.openURL) private var openURL
    @State private var isWritingOwnWords = false
    @State private var words = ""
    @State private var showsWhy = false

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
                if isWritingOwnWords { ownWords } else { content }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 16)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            actions.padding(.horizontal, 20).padding(.bottom, 8).background(Palette.bg)
        }
    }

    // MARK: Top

    private var meta: some View {
        HStack(spacing: 12) {
            Caps("\(position) of \(total)", color: Palette.muted)
            Capsule().fill(Palette.line).frame(height: 1)
                .overlay(alignment: .leading) {
                    GeometryReader { proxy in
                        Capsule().fill(Palette.fg).frame(
                            width: proxy.size.width * Double(position) / Double(max(total, 1)))
                    }
                }
            if let deadline = check.deadline {
                Caps("By \(deadline.formatted(.dateTime.weekday(.abbreviated).hour().minute()))", color: Palette.flag)
            }
        }
        .frame(height: 24)
        .accessibilityElement(children: .combine)
    }

    private var chips: some View {
        HStack(spacing: 8) {
            Label(asker, systemImage: provider == nil ? "sparkle" : "sparkle")
                .labelStyle(.titleAndIcon).font(.manrope(14, weight: 600, relativeTo: .footnote))
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
                    .font(.manrope(14, weight: 600, relativeTo: .footnote)).foregroundStyle(Palette.fg)
                    .padding(.horizontal, 14).frame(minHeight: 40).background(Color.fillTint, in: .capsule)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Matter: \(matter.name)")
            }
        }
    }

    /// Who is asking: the agent's runtime, or Life (a voice says it came from the pendant).
    private var asker: String {
        if let provider { return provider.name }
        return check.group == .voice
            ? "Life, from the pendant"
            : check.asker.caseInsensitiveCompare("life") == .orderedSame ? "Life" : check.asker
    }

    // MARK: Body

    @ViewBuilder private var content: some View {
        if let draft = check.draft { DraftBlock(draft: draft) }
        if let evidence = check.evidence { EvidenceBlock(evidence: evidence) }
        if !check.clips.isEmpty { ClipBlock(clips: check.clips) }
        if let context = check.context, !context.isEmpty {
            DisclosureGroup(isExpanded: $showsWhy) {
                Text(context).font(.body15).foregroundStyle(Palette.muted).frame(
                    maxWidth: .infinity, alignment: .leading
                )
                .padding(.top, 6).fixedSize(horizontal: false, vertical: true)
            } label: {
                Text(whyLabel).font(.manrope(16, weight: 500)).foregroundStyle(Palette.muted)
            }
            .tint(Palette.muted)
            .padding(.vertical, 12)
            .overlay(alignment: .top) { Hairline() }
            .overlay(alignment: .bottom) { Hairline() }
        }
    }

    private var whyLabel: String {
        switch check.group {
        case .card: "Where Life found it"
        case .ending: "What rests on it"
        case .voice: "Why Life thinks so"
        default: "Why, and what it rests on"
        }
    }

    private var ownWords: some View {
        VStack(alignment: .leading, spacing: 10) {
            Caps("Your answer")
            TextField("Say it in your own words", text: $words, axis: .vertical)
                .font(.manrope(19, weight: 450)).foregroundStyle(Palette.fg).lineLimit(3...8)
                .padding(16).background(Palette.card, in: .rect(cornerRadius: 20))
            Text("Your words go to the agent as they are.").font(.small).foregroundStyle(Palette.faint)
        }
    }

    // MARK: Actions

    private var actions: some View {
        VStack(spacing: 8) {
            if isWritingOwnWords {
                Button {
                    answer(
                        AnswerRequest(
                            ref: check.ref, options: [], note: words.trimmingCharacters(in: .whitespacesAndNewlines)))
                } label: {
                    Text("Send my answer")
                }
                .buttonStyle(.pill(.filled))
                .disabled(words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Back to the options") { isWritingOwnWords = false }.buttonStyle(.pill(.quiet, height: 48))
            } else {
                options
                HStack {
                    Button {
                        isWritingOwnWords = true
                    } label: {
                        Label("Something else", systemImage: "mic").font(.manrope(16, weight: 600)).foregroundStyle(
                            Palette.fg
                        )
                        .frame(minHeight: 44)
                    }
                    Spacer(minLength: 12)
                    if let link = check.links.first.flatMap(URL.init(string:)) {
                        Button {
                            openURL(link)
                        } label: {
                            Text("Open in \(provider?.name ?? "its app") \(Image(systemName: "arrow.up.right"))")
                                .font(.manrope(15, weight: 500)).foregroundStyle(Palette.muted).frame(minHeight: 44)
                        }
                    }
                }
                if let line = silence {
                    Text(line).font(.small).foregroundStyle(Palette.faint).multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
            }
        }
    }

    @ViewBuilder private var options: some View {
        if let first = check.options.first {
            Button {
                tap(first)
            } label: {
                HStack(spacing: 10) {
                    if first.outgoing == true { Image(systemName: "arrow.up").accessibilityHidden(true) }
                    Text(first.label)
                }
            }
            .buttonStyle(.pill(.filled, height: 54))
            let rest = Array(check.options.dropFirst())
            if !rest.isEmpty {
                let layout = rest.count > 2 ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
                layout {
                    ForEach(rest, id: \.id) { option in
                        Button(option.label) { tap(option) }.buttonStyle(.pill(.quiet, height: 48))
                    }
                }
            }
        }
    }

    private func tap(_ option: Check.Option) {
        answer(AnswerRequest(ref: check.ref, options: [option.id]))
    }

    /// What happens when he does not answer: Life's own words for the kinds that have a standing rule, the asker's option otherwise.
    private var silence: String? {
        switch check.group {
        case .ending: return "Until you say, Life treats it as probably done."
        case .voice: return "Until you say, the voice stays unnamed."
        case .name, .guessedPerson: return "Until you say, Life keeps its guess."
        case .card: return "Nothing starts unless you say so."
        case .decision, .unknown:
            guard let deadline = check.deadline else { return nil }
            let when = deadline.formatted(.dateTime.weekday(.wide).hour().minute())
            if check.draft != nil { return "No answer by \(when): nothing is sent." }
            let chosen = check.options.first { $0.id == check.onSilence }?.label
            return "No answer by \(when): " + (chosen.map { "“\($0)”." } ?? "nothing happens.")
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
                .font(.manrope(15, weight: 500)).foregroundStyle(Palette.muted)
            if let subject = draft.subject {
                Text(subject).font(.manrope(15, weight: 650)).foregroundStyle(Palette.fg)
            }
            if let quoted = draft.quoted {
                VStack(alignment: .leading, spacing: 2) {
                    Label("Answering \(quoted.sender)’s message", systemImage: "arrowshape.turn.up.left")
                        .font(.manrope(15, weight: 650)).foregroundStyle(Palette.fg)
                    Text(quoted.text).font(.body15).foregroundStyle(Palette.muted).lineLimit(3)
                }
                .padding(.horizontal, 14).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.fillTint, in: .rect(cornerRadius: 14))
            }
            if let text = draft.text {
                Text(text).font(.manrope(19, weight: 450)).foregroundStyle(Palette.fg).fixedSize(
                    horizontal: false, vertical: true)
            }
            if let reaction = draft.reaction { Text(reaction).font(.system(size: 34)) }
            if let file = draft.file {
                Label("\(file.name) · \(file.size.formatted(.byteCount(style: .file)))", systemImage: "doc")
                    .font(.manrope(15, weight: 500)).foregroundStyle(Palette.fg)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .accessibilityElement(children: .combine)
    }
}

/// The words a card rests on, and where they came from.
private struct EvidenceBlock: View {
    let evidence: Check.Evidence

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("“\(evidence.quote)”").font(.manrope(19, weight: 450)).foregroundStyle(Palette.fg)
                .fixedSize(horizontal: false, vertical: true)
            Text(evidence.from).font(.small).foregroundStyle(Palette.muted)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .accessibilityElement(children: .combine)
    }
}

/// The clips of a voice to name, each played from the server's cut of its recording.
private struct ClipBlock: View {
    let clips: [Check.Clip]

    @Environment(PlaybackStore.self) private var playback
    @State private var index = 0

    var body: some View {
        let clip = clips[min(index, clips.count - 1)]
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 14) {
                Button {
                    toggle(clip)
                } label: {
                    Image(systemName: playback.isPlaying ? "stop.fill" : "play.fill").font(.system(size: 17))
                        .foregroundStyle(Palette.on).frame(width: 48, height: 48).background(Palette.fg, in: .circle)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(playback.isPlaying ? "Stop" : "Play the clip")
                VStack(alignment: .leading, spacing: 6) {
                    Text("“\(clip.text)”").font(.manrope(19, weight: 450)).foregroundStyle(Palette.fg)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(caption(clip)).font(.monoTime).foregroundStyle(Palette.muted)
                }
            }
            if clips.count > 1 {
                Button("Another clip") {
                    playback.stop(); index = (index + 1) % clips.count
                }
                .font(.manrope(15, weight: 600)).foregroundStyle(Palette.fg).frame(minHeight: 44)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .onDisappear { playback.stop() }
    }

    private func caption(_ clip: Check.Clip) -> String {
        let seconds = clip.audio.map { Int(($0.end - $0.start).rounded()) } ?? 0
        let length = "\(seconds / 60):" + String(format: "%02d", seconds % 60)
        return "\(length) · \(min(index, clips.count - 1) + 1) of \(clips.count) clip\(clips.count == 1 ? "" : "s")"
    }

    private func toggle(_ clip: Check.Clip) {
        if playback.isPlaying { return playback.stop() }
        guard let audio = clip.audio, let job = UUID(uuidString: audio.jobId) else { return }
        Task {
            guard let file = await ClipAudio.file(job) else { return }
            playback.play(file, from: audio.start, for: audio.end - audio.start)
        }
    }
}
