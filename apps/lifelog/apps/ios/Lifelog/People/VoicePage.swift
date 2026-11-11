import Library
import ServerAPI
import SwiftUI
import Timeline

/// One voice: the question, the facts, the clips and the answers. "Several people" names each clip in place, under it.
struct VoicePage: View {
    let voice: NamingQueue.Voice
    let people: [CachedPerson]
    let answer: (ServerClient.NamingAnswer) -> Void
    /// One clip's turn named in place, at once.
    let name: (NamingQueue.Clip, ServerClient.SpeakerTarget) -> Void
    let skip: () -> Void

    @Environment(PlaybackStore.self) private var playback
    @Environment(NamingQueue.self) private var naming: NamingQueue?
    /// The clip this page last played, so the next one follows it.
    @State private var playing: Int?
    @State private var draft = ""
    @FocusState private var typing: Bool
    /// "Several people": who says each clip, by its index; `nil` until asked.
    /// "Several people": who says each clip, one or more.
    @State private var picks: [Int: [WhoPills.Pick]]?
    /// "Several people": who is in it, ticked without naming a clip.
    @State private var among: Set<UUID> = []

    private var item: ServerClient.NamingItem { voice.item }
    /// Who it sounds like, when it sounds like one of the owner's people.
    private var known: CachedPerson? {
        [.knownPerson, .recheck].contains(item.kind)
            ? item.personId.flatMap { id in people.first { $0.id == id } } : nil
    }
    /// A recheck: who the owner named it before.
    private var named: CachedPerson? {
        item.kind == .recheck ? item.namedPersonId.flatMap { id in people.first { $0.id == id } } : nil
    }
    /// Everyone, the most like this voice first (the server's `likely`), then by name.
    private var ranked: [CachedPerson] {
        let place = Dictionary((item.likely ?? []).enumerated().map { ($1, $0) }, uniquingKeysWith: min)
        return people.sorted {
            (place[$0.id] ?? .max, $0.name) < (place[$1.id] ?? .max, $1.name)
        }
    }
    /// Everyone else, for "someone else".
    private var others: [CachedPerson] { ranked.filter { $0.id != known?.id && $0.id != named?.id } }
    /// The name the summaries heard; the server leaves it out when it is the known person's. Beside a known person
    /// both are shown, and either is one tap.
    private var heard: String? { item.name }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                header
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(voice.clips.indices, id: \.self) { index in
                        VoiceClipRow(clip: voice.clips[index], isCurrent: playing == index) {
                            toggle(index)
                        }
                        if picks != nil, voice.clips[index].item.turnIndex != nil { whoSays(index) }
                    }
                    if voice.clips.isEmpty {
                        // Said rather than left blank: the server cut no clip of this voice yet.
                        Label("No clip of this voice yet.", systemImage: "waveform.slash")
                            .labelStyle(.decorativeIcon)
                            .font(.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                answers
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
        .task {
            if item.kind == .several { openSeveral() }
            play(0)
        }
        .onChange(of: playback.position) { follow() }
        .onChange(of: playback.isPlaying) { follow() }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(question)
                .font(.statusSentence)
                .foregroundStyle(Palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(facts)
                .font(.subheadline)
                .foregroundStyle(Palette.textSecondary)
            if let why {
                Text(why)
                    .font(.subheadline)
                    .foregroundStyle(Palette.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var question: String {
        if picks != nil || item.kind == .several { return "Several people in this voice" }
        if let named { return named.isOwner ? "You said this was you" : "You named this \(named.name)" }
        if let known { return known.isOwner ? "Is this you?" : "Is this \(known.name)?" }
        if let name = item.name { return "Is this \(name)?" }
        return "Who’s this?"
    }

    /// "Sat, Oct 11 · 7 conversations · 23 min with you".
    private var facts: String {
        let talk = Duration.seconds(item.seconds).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated))
        let conversations = String(
            AttributedString(localized: "^[\(item.conversations) conversation](inflect: true)").characters)
        let day = voice.lastSeen?.date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        return ([day, conversations, "\(talk) with you"].compactMap(\.self)).joined(separator: " · ")
    }

    private var why: String? {
        if picks != nil {
            return (item.kind == .several ? "You said so before. " : "")
                + "Tick who is in it, or under each passage everyone who speaks in it; the others go to whoever they sound like among them."
        }
        let called = heard.map { name in
            item.evidence.first.map { "someone called it “\(name)”: “\($0.text)”" } ?? "someone called it “\(name)”"
        }
        if let known {
            let sounds = known.isOwner ? "It sounds like your voice" : "It sounds like \(known.name)"
            if named != nil { return "\(sounds) in your other conversations." }
            return called.map { "\(sounds), but \($0)" } ?? "\(sounds)."
        }
        if let called { return called.prefix(1).uppercased() + called.dropFirst() }
        return "A voice you talked with, not named yet."
    }

    // MARK: Answers

    private var answers: some View {
        VStack(alignment: .leading, spacing: 18) {
            if picks == nil, let named {
                Button {
                    answer(.assign(named.id))
                } label: {
                    Text(named.isOwner ? "Keep, it’s me" : "Keep \(named.name)").frame(maxWidth: .infinity)
                }
                .primaryGlassButton()
                .controlSize(.large)
                .accessibilityIdentifier("naming.keep")
                if let known {
                    Button {
                        answer(.assign(known.id))
                    } label: {
                        Text(known.isOwner ? "It’s me" : "It’s \(known.name)").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.large)
                    .tint(Palette.textPrimary)
                    .accessibilityIdentifier("naming.yes")
                }
            } else if picks == nil, let known {
                Button {
                    answer(.assign(known.id))
                } label: {
                    Text(known.isOwner ? "Yes, it’s me" : "Yes, \(known.name)").frame(maxWidth: .infinity)
                }
                .primaryGlassButton()
                .controlSize(.large)
                .accessibilityIdentifier("naming.yes")
                if let heard {
                    Button {
                        answer(.confirm(name: heard))
                    } label: {
                        Text("No, it’s \(heard)").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.large)
                    .tint(Palette.textPrimary)
                    .accessibilityIdentifier("naming.heard")
                }
            } else if picks == nil, let name = item.name {
                Button {
                    answer(.confirm(name: name))
                } label: {
                    Text("Yes, \(name)").frame(maxWidth: .infinity)
                }
                .primaryGlassButton()
                .controlSize(.large)
                .accessibilityIdentifier("naming.yes")
            }
            if let picks {
                FlowLayout(spacing: 8) {
                    ForEach(ranked.filter { !$0.isOwner }) { person in
                        WhoPills.pill(person.name, among.contains(person.id)) {
                            among.formSymmetricDifference([person.id])
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Who’s in it")
                Button {
                    // The owner is among them, as in nearly every conversation he records.
                    let chosen = picks.values.joined().compactMap { pick -> UUID? in
                        switch pick.target {
                        case .person(let id), .new(_, let id): id
                        default: nil
                        }
                    }
                    let owner = people.first(where: \.isOwner)?.id
                    answer(
                        .several(
                            people: Array(among.union(chosen + [owner].compactMap(\.self))),
                            // Someone unknown too when a clip says so; a video is nobody.
                            unknown: picks.values.joined().contains(WhoPills.unknown)
                        ))
                } label: {
                    Text("Done").frame(maxWidth: .infinity)
                }
                .primaryGlassButton()
                .controlSize(.large)
                .disabled(picks.isEmpty && among.isEmpty)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    if known != nil || named != nil || item.name != nil {
                        Text("Or someone else")
                            .font(.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                    }
                    nameField
                    FlowLayout(spacing: 8) {
                        ForEach(others) { person in
                            WhoPills.pill(person.isOwner ? "Me" : person.name, false) { answer(.assign(person.id)) }
                        }
                    }
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 20) { quietAnswers }
                VStack(alignment: .leading, spacing: 14) { quietAnswers }
            }
            .font(.subheadline)
            .buttonStyle(.borderless)
            .foregroundStyle(Palette.textSecondary)
        }
    }

    /// Under a clip, once "several people" is asked: who says it.
    private func whoSays(_ index: Int) -> some View {
        let shown = [people.first(where: \.isOwner), known].compactMap { $0.map(WhoPills.pick) }
        // One tap for a clip that is nobody to name, last (11 Nov: they were hidden in "Someone else").
        let nobody = [WhoPills.unknown, WhoPills.media]
        let suggested = (picks ?? [:]).sorted { $0.key < $1.key }.flatMap(\.value).reduce(into: shown) { all, pick in
            if !all.contains(pick), !nobody.contains(pick) { all.append(pick) }
        }
        return WhoPills(people: people, suggested: suggested + nobody, picked: picks?[index] ?? []) {
            choose($0, for: index)
        }
        // Under the clip's words, past its play button.
        .padding(.leading, 62)
        .padding(.bottom, 8)
    }

    /// A new name: the main answer when nobody is suggested.
    private var nameField: some View {
        let suggested = known != nil || named != nil || item.name != nil
        return HStack(spacing: 8) {
            TextField(suggested ? "Another name" : "Their name", text: $draft)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($typing)
                .onSubmit(save)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(Palette.surface1, in: .capsule)
                .overlay(Capsule().strokeBorder(Palette.hairline))
                .accessibilityIdentifier("naming.name")
            if !trimmed.isEmpty {
                if suggested {
                    Button("Save", action: save).buttonStyle(.bordered).buttonBorderShape(.capsule)
                } else {
                    Button("Save", action: save).primaryGlassButton().buttonBorderShape(.capsule)
                }
            }
        }
        .motion(Motion.standard, value: trimmed.isEmpty)
    }

    @ViewBuilder private var quietAnswers: some View {
        if picks == nil {
            Button("Not anyone I know") { answer(.ignore) }
                .accessibilityHint("It isn’t asked about again.")
            Button("Not relevant") { answer(.notRelevant) }
                .accessibilityHint("You may know them. It isn’t asked about again.")
            Button("Video or TV") { answer(.media) }
                .accessibilityHint("Left out of summaries and search.")
            Button("Several people", action: openSeveral)
                .accessibilityHint("Name who says each clip.")
        } else if item.kind != .several {
            Button("Back") { picks = nil }
        }
        Button("Later", action: skip)
            .accessibilityHint("Moves this voice to the end.")
    }

    /// Several people: each clip opens on who its turn reads as now, when that is one of the owner's people.
    private func openSeveral() {
        typing = false
        picks = voice.clips.indices.reduce(into: [:]) { picks, index in
            let reads = voice.clips[index].item.personId
            picks[index] = people.first { $0.id == reads }.map { [WhoPills.pick($0)] }
        }
    }

    /// Clip `index` is said by `pick` too, or no longer: its turn is the owner's answer now. People add up (a clip
    /// several of them speak in); "Don't know", a video or someone new stand alone.
    private func choose(_ pick: WhoPills.Pick, for index: Int) {
        let ids = { (picks: [WhoPills.Pick]) in
            picks.compactMap { if case .person(let id) = $0.target { id } else { nil } }
        }
        var said = picks?[index] ?? []
        if case .person = pick.target, ids(said).count == said.count {
            if let at = said.firstIndex(of: pick) { said.remove(at: at) } else { said.append(pick) }
        } else {
            said = [pick]
        }
        // The last name can't be unticked: a turn he named stays named.
        guard !said.isEmpty, said != picks?[index] else { return }
        picks?[index] = said
        name(voice.clips[index], said.count == 1 ? said[0].target : .several(people: ids(said), unknown: false))
    }

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func save() {
        typing = false
        guard !trimmed.isEmpty else { return }
        answer(.confirm(name: trimmed))
    }

    // MARK: Playback

    /// Plays clip `index`, or pauses it when it is the one playing.
    private func toggle(_ index: Int) {
        if playing == index, playback.isPlaying { return playback.pause() }
        play(index)
    }

    /// The server's clip from its own audio when it has it, else this phone's recording. The page plays its first clip
    /// as it opens, often before `NamingQueue.prepare` has fetched that audio: it waits for it here.
    private func play(_ index: Int) {
        guard voice.clips.indices.contains(index), let id = voice.clips[index].playbackID,
            let range = voice.clips[index].range
        else {
            playing = nil
            return
        }
        let clip = voice.clips[index]
        playing = index
        Task {
            let file = if let audio = clip.item.audio { await naming?.file(audio.jobId) } else { URL?.none }
            // Another clip was asked for while this one's audio was fetched.
            guard playing == index else { return }
            if let file, let audio = clip.item.audio {
                playback.open(
                    id: id, title: "Who’s this?", range: range,
                    source: .file(file, fileMillis: Int64(audio.start * 1000)), autoplay: true)
            } else if let conversation = clip.conversation {
                playback.open(conversation, at: range.lowerBound, span: range, autoplay: true)
            }
        }
    }

    /// At the end of a clip the next one plays, until the last.
    private func follow() {
        guard let playing, let range = voice.clips[playing].range, let position = playback.position,
            playback.item?.range == range, position >= range.upperBound.advanced(by: -250)
        else { return }
        if voice.clips.indices.contains(playing + 1), voice.clips[playing + 1].isPlayable {
            play(playing + 1)
        } else {
            playback.pause()
            self.playing = nil
        }
    }
}
