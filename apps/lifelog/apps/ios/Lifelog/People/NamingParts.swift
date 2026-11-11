import Library
import ServerAPI
import SwiftUI
import Timeline

/// Who says a passage, as pills: the one way to name a turn, under a clip of "Who's this?" and under a passage of a
/// conversation. The owner, who it sounds like and whoever another passage just went to are one tap; anyone else,
/// someone new, nobody known or a video are in "Someone else".
struct WhoPills: View {
    struct Pick: Equatable {
        let target: ServerClient.SpeakerTarget
        let name: String
    }

    let people: [CachedPerson]
    let suggested: [Pick]
    let picked: Pick?
    /// Every passage of the voice rather than this one; `nil` where only the passage can be named.
    var everywhere: Binding<Bool>?
    /// Splits the conversation at the passage; `nil` where it can't be.
    var split: (() -> Void)?
    let choose: (Pick) -> Void

    @State private var asking = false
    @State private var draft = ""

    var body: some View {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        FlowLayout(spacing: 8) {
            ForEach(suggested, id: \.name) { pick in
                Self.pill(pick.name, pick == picked) { choose(pick) }
            }
            Menu("Someone else") {
                ForEach(people.filter { person in !suggested.contains { $0.target == .person(person.id) } }) {
                    person in
                    Button(person.name) { choose(Self.pick(person)) }
                }
                Button("Someone new", systemImage: "person.badge.plus") { asking = true }
                if !suggested.contains(Self.unknown) {
                    Button(Self.unknown.name, systemImage: "questionmark") { choose(Self.unknown) }
                }
                if !suggested.contains(Self.media) {
                    Button(Self.media.name, systemImage: "tv") { choose(Self.media) }
                }
                if let split { Button("Split the conversation here", systemImage: "scissors", action: split) }
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .tint(Palette.textSecondary)
            if let everywhere {
                Self.pill("Every passage", everywhere.wrappedValue) { everywhere.wrappedValue.toggle() }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Who says it")
        .alert("Who’s this?", isPresented: $asking) {
            TextField("Name", text: $draft).textInputAutocapitalization(.words)
            // A typed name is the person called so, else someone new under an id of the phone's.
            Button("Save") {
                choose(
                    people.first { $0.name.localizedCaseInsensitiveCompare(trimmed) == .orderedSame }.map(Self.pick)
                        ?? Pick(target: .new(name: trimmed), name: trimmed))
            }
            .disabled(trimmed.isEmpty)
            Button("Cancel", role: .cancel) {}
        }
        .onChange(of: asking) { draft = "" }
    }

    /// Nobody he can or cares to name.
    static let unknown = Pick(target: .unknown, name: "Don’t know")
    static let media = Pick(target: .media, name: "Video or TV")

    static func pick(_ person: CachedPerson) -> Pick {
        Pick(target: .person(person.id), name: person.isOwner ? "Me" : person.name)
    }

    /// A person to pick: ticked once picked, so the choice never rests on color alone.
    static func pill(_ title: String, _ ticked: Bool, action: @escaping () -> Void) -> some View {
        Button(ticked ? "✓ \(title)" : title, action: action)
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .tint(ticked ? Palette.redText : Palette.textPrimary)
            .accessibilityAddTraits(ticked ? .isSelected : [])
    }
}

/// One clip: its words, each lit as it is spoken, and where and when. Tapping plays or pauses it.
struct VoiceClipRow: View {
    let clip: NamingQueue.Clip
    let isCurrent: Bool
    let toggle: () -> Void

    @Environment(PlaybackStore.self) private var playback

    private var isLoaded: Bool { playback.item?.id == clip.playbackID && playback.item?.range == clip.range }
    private var isPlaying: Bool { isCurrent && isLoaded && playback.isPlaying }
    private var isLoading: Bool { isCurrent && isLoaded && playback.status == .loading }

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .top, spacing: 14) {
                icon
                VStack(alignment: .leading, spacing: 8) {
                    PassageText(
                        text: "“\(clip.item.text)”", color: isCurrent ? Palette.textPrimary : Palette.textBody,
                        lit: lit, quote: true)
                    Text(detail)
                        .font(.monoDetail)
                        .foregroundStyle(Palette.textTertiary)
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .background(isCurrent ? Palette.surface2 : Palette.surface1, in: .rect(cornerRadius: 16))
            .overlay {
                RoundedRectangle(cornerRadius: 16).strokeBorder(isCurrent ? Palette.hairline : .clear)
            }
            .contentShape(.rect(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .disabled(!clip.isPlayable)
        .accessibilityLabel(clip.item.text)
        .accessibilityValue(detail)
        .accessibilityHint(!clip.isPlayable ? "" : isPlaying ? "Pauses." : "Plays this clip.")
        .accessibilityIdentifier("naming.clip")
        .motion(Motion.standard, value: isCurrent)
    }

    @ViewBuilder private var icon: some View {
        ZStack {
            Circle().fill(isCurrent ? Palette.redFill : Palette.surface3)
            if isLoading {
                ProgressView().controlSize(.small).tint(Palette.textOnRed)
            } else {
                Image(systemName: !clip.isPlayable ? "text.quote" : isPlaying ? "pause.fill" : "play.fill")
                    .font(.subheadline)
                    .foregroundStyle(isCurrent ? Palette.textOnRed : Palette.textPrimary)
                    .contentTransition(.symbolEffect(.replace))
            }
        }
        .frame(width: 34, height: 34)
        .accessibilityHidden(true)
    }

    /// The word being spoken, after the opening quote.
    private var lit: NSRange? {
        guard isCurrent, isLoaded, let start = clip.range?.lowerBound, let position = playback.position,
            let word = clip.item.words?.spoken(at: start.distance(to: position), in: clip.item.text)
        else { return nil }
        return NSRange(location: word.location + 1, length: word.length)
    }

    /// "Home · 17:56 · 0:07", or why it can't play.
    private var detail: String {
        guard clip.isPlayable, let range = clip.range else { return "The audio isn’t on this phone" }
        if isCurrent, isLoaded, case .unavailable(let why) = playback.status { return why }
        let time = range.lowerBound.date.formatted(.dateTime.hour().minute())
        let length = PlayerClock.string(range.lowerBound.distance(to: range.upperBound))
        return [clip.place, time, length].compactMap(\.self).joined(separator: " · ")
    }
}

/// Every voice is named.
struct CaughtUp: View {
    let done: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Text("All caught up")
                .font(.statusSentence)
                .foregroundStyle(Palette.textPrimary)
            Text("Voices you talk with show up here the morning after.")
                .font(.subheadline)
                .foregroundStyle(Palette.textSecondary)
                .multilineTextAlignment(.center)
            Button("Done", action: done)
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .padding(.top, 8)
        }
        .padding(32)
    }
}
