import LifeConnector
import SwiftUI

/// Every voice to name, folded into one row ("Name 3 voices", the voice mark, never a face). Unfolded, one voice at a
/// time: one short moment to read along, the one suggestion first, answers on one line; "Someone else" hands the name
/// to the Ask Life field and lists his people that match what he types (owner, 26 Nov 2026).
struct VoicesRow: View {
    @Environment(LifeStore.self) private var life
    @Environment(\.calendar) private var calendar
    @State private var isOpen = false
    @State private var clip = 0

    private var asks: [ThreadAsk] { life.items.value?.voices ?? [] }
    private var current: Check? { asks.first?.check }
    private var isNaming: Bool { life.naming != nil && life.naming == current?.ref }
    private var isRunning: Bool { current.map { life.state(of: .answer(ref: $0.ref)).isRunning } ?? false }

    var body: some View {
        if let check = current {
            ThreadItemRow(
                title: isOpen ? "Who is this voice?" : asks.count == 1 ? "Name one voice" : "Name \(asks.count) voices",
                state: .needsYou, icon: .wave, line: isOpen ? heard(check) : "Voices from your conversations",
                isOpen: isOpen, ref: OpeningScreen.voices,
                later: { Task { for ask in asks { await life.later(ask.ref) } } },
                toggle: {
                    Motion.animate { isOpen.toggle() }
                    if isOpen {
                        life.opened = OpeningScreen.voices
                    } else if life.opened == OpeningScreen.voices {
                        life.opened = nil
                    }
                }
            ) {
                detail(check).transition(Motion.appears)
            }
            .onChange(of: check.ref) { clip = 0 }
            .onDisappear { life.naming = nil }
        }
    }

    /// "Heard Tue at 14:20 · 3 times": when the newest moment was said, and how many conversations hold the voice.
    private func heard(_ check: Check) -> String {
        let at = check.clips.compactMap(\.at).max()
        let day = at.map {
            calendar.isDate($0, inSameDayAs: life.now()) ? "today" : $0.formatted(.dateTime.weekday(.abbreviated))
        }
        let when = [day, at?.clock].compactMap(\.self).joined(separator: " at ")
        let times = (check.conversations ?? 0) > 1 ? " · \(check.conversations ?? 0) times" : ""
        return when.isEmpty ? "Heard" + times : "Heard " + when + times
    }

    @ViewBuilder private func detail(_ check: Check) -> some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            if let last = life.namedVoice, last.ref != check.ref { lastLine(last) }
            if !check.clips.isEmpty { moment(check) }
            if isNaming { naming(check) } else { answers(check) }
        }
        .opacity(isRunning ? Metrics.Opacity.dim : 1).allowsHitTesting(!isRunning)
        .motion(Motion.standard, value: isNaming).motion(Motion.standard, value: check.ref)
    }

    /// "Clara Hart: named in 3 conversations · Undo" (Undo only while Life holds one for that answer).
    private func lastLine(_ last: LifeStore.NamedVoice) -> some View {
        let n = last.conversations ?? 0
        let words = "\(last.who): named in \(max(n, 1)) conversation\(n > 1 ? "s" : "")"
        return HStack(spacing: 0) {
            Text(words).foregroundStyle(Palette.muted)
            if life.ask(last.ref)?.undoLine != nil {
                Text(" · ").foregroundStyle(Palette.muted)
                Button("Undo") { Task { await life.undo(last.ref) } }.foregroundStyle(Palette.fg)
                    .accessibilityIdentifier(AID.voicesUndo)
            }
        }
        .font(.line)
    }

    private func moment(_ check: Check) -> some View {
        let shown = check.clips[clip % check.clips.count]
        return VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            ReadAlong(clip: shown.trimmed()).id("\(check.ref)-\(clip)")
            if check.clips.count > 1 {
                Button("Another moment") { clip += 1 }.font(.line).foregroundStyle(Palette.fg)
                    .padding(.leading, Metrics.tapTarget + Metrics.Spacing.m).identified(AID.voicesAnother)
            }
        }
    }

    // MARK: Answers

    private func answers(_ check: Check) -> some View {
        let guess = check.options.contains { $0.id == "is-them" } ? check.likelyPeople.first : nil
        return HStack(spacing: Metrics.Spacing.s) {
            if let guess {
                let name = guess.isOwner ? "me" : String(guess.name.split(separator: " ").first ?? "")
                pill("It’s \(name)", .filled, id: "is-them") {
                    let option = check.options.first { $0.id == "is-them" }
                    Task { await life.answerVoice(check, option.flatMap(check.answer), who: guess.name) }
                }
                pill("Someone else", .quiet, id: "else") { startNaming(check) }
            } else {
                pill("Say who it is", .filled, id: "else") { startNaming(check) }
            }
            pill("Not a person", .quiet, id: "media") {
                Task { await life.answerVoice(check, check.answerMedia, who: nil) }
            }
            pill("Later", .quiet, id: "later") { Task { await life.later(check.ref) } }
        }
    }

    /// A pill sized to its words, so the four answers stay on one line.
    private func pill(_ title: String, _ kind: PillStyle.Kind, id: String, action: @escaping () -> Void) -> some View {
        let isFilled = kind == .filled
        return Button(action: action) {
            Text(title).font(.heading).lineLimit(1).foregroundStyle(isFilled ? Palette.on : Palette.fg)
                .padding(.horizontal, Metrics.Spacing.m).frame(minHeight: 44)
                .background(isFilled ? Palette.fg : Palette.tint, in: .capsule)
        }
        .buttonStyle(.plain).fixedSize(horizontal: true, vertical: false).identified(AID.voicesAnswer(id))
    }

    private func startNaming(_ check: Check) {
        life.namingWords = ""
        life.naming = check.ref
        Task { await life.refreshPeople() }
    }

    // MARK: Naming

    private func naming(_ check: Check) -> some View {
        let typed = life.namingWords.trimmingCharacters(in: .whitespaces)
        let matches = life.namingMatches
        return VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            Text("Who is it? Type or say their name below.").font(.line).foregroundStyle(Palette.muted)
            ForEach(matches, id: \.ref) { party in
                person(party.name, id: party.ref, face: Face(party: party, size: 36)) {
                    Task { await life.answerVoice(check, check.answer(naming: .person(party.ref)), who: party.name) }
                }
            }
            if !typed.isEmpty,
                !matches.contains(where: { $0.name.localizedCaseInsensitiveCompare(typed) == .orderedSame })
            {
                person(typed, id: "new", face: Image(systemName: "plus").font(.bodyStrong), note: "new person") {
                    Task {
                        await life.answerVoice(
                            check, AnswerRequest(ref: check.ref, options: ["this-is"], name: typed), who: typed)
                    }
                }
            }
            HStack(spacing: Metrics.Spacing.s) {
                pill("Back", .quiet, id: "back") { life.naming = nil }
                pill("Leave unnamed", .quiet, id: "unnamed") {
                    Task { await life.answerVoice(check, check.answerDontName, who: nil) }
                }
            }
        }
    }

    private func person(
        _ name: String, id: String, face: some View, note: String? = nil, pick: @escaping () -> Void
    ) -> some View {
        Button(action: pick) {
            HStack(spacing: Metrics.Spacing.m) {
                face.frame(width: 36, height: 36).background(Palette.tint, in: .circle)
                Text(name).font(.bodyStrong).lineLimit(1)
                Spacer(minLength: 0)
                if let note { Text(note).font(.line).foregroundStyle(Palette.muted) }
            }
            .padding(.leading, 6).padding(.trailing, 14).frame(minHeight: 48).background(Palette.tint, in: .capsule)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain).identified(AID.voicesPerson(id))
    }
}
