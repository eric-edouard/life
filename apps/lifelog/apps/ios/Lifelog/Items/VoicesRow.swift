import LifeConnector
import SwiftUI

/// Every voice to name, folded into one row ("Name 3 voices", an empty face: no one yet). Unfolded, one voice at a
/// time, "Who is this?": one short moment to read along (no duration, no count: his rules of 26 Nov 2026), the one suggestion first, answers on one line; "Someone else" hands the name
/// to the Ask Life field and lists his people that match what he types (owner, 26 Nov 2026).
struct VoicesRow: View {
    @Environment(LifeStore.self) private var life
    @Environment(\.calendar) private var calendar
    /// Past the default text sizes the answers and names wrap, so no words are cut.
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var isOpen = false
    @State private var clip = 0

    private var asks: [ThreadAsk] { life.items.value?.voices ?? [] }
    private var current: Check? { asks.first?.check }
    private var isNaming: Bool { life.naming != nil && life.naming == current?.ref }
    private var isRunning: Bool { current.map { life.state(of: .answer(ref: $0.ref)).isRunning } ?? false }

    var body: some View {
        if let check = current {
            ThreadItemRow(
                title: isOpen ? "Who is this?" : asks.count == 1 ? "Name one voice" : "Name \(asks.count) voices",
                state: .needsYou, icon: .person, line: isOpen ? heard(check) : "From your conversations",
                isOpen: isOpen, ref: OpeningScreen.voices,
                pill: RowPill(title: "Later", id: nil) { Task { for ask in asks { await life.later(ask.ref) } } },
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

    /// "Heard Tue at 14:20": when the newest moment was said.
    private func heard(_ check: Check) -> String {
        let at = check.clips.compactMap(\.at).max()
        let day = at.map {
            calendar.isDate($0, inSameDayAs: life.now()) ? "today" : $0.formatted(.dateTime.weekday(.abbreviated))
        }
        let when = [day, at?.clock].compactMap(\.self).joined(separator: " at ")
        return when.isEmpty ? "Heard" : "Heard " + when
    }

    @ViewBuilder private func detail(_ check: Check) -> some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            if let last = life.namedVoice, last.ref != check.ref { lastLine(last) }
            if !check.clips.isEmpty { moment(check) }
            // Why Life suggests who it suggests, under the moment, while he has not turned to someone else.
            if !isNaming,
                let why = suggestion(check).flatMap({ guess in
                    check.voiceGuesses?.first { $0.person.ref == guess.ref }?.why
                })
            {
                Text(why).font(.line).foregroundStyle(Palette.muted)
            }
            if isNaming { naming(check) } else { answers(check) }
        }
        .opacity(isRunning ? Metrics.Opacity.dim : 1).allowsHitTesting(!isRunning)
        .motion(Motion.standard, value: isNaming).motion(Motion.standard, value: check.ref)
    }

    /// "Clara Hart: named · Undo" (Undo only while Life holds one for that answer).
    private func lastLine(_ last: LifeStore.NamedVoice) -> some View {
        HStack(spacing: 0) {
            Text("\(last.who): named").foregroundStyle(Palette.muted)
            if life.ask(last.ref)?.undoLine != nil {
                Text(" · ").foregroundStyle(Palette.muted)
                Button("Undo") { Task { await life.undo(last.ref) } }.foregroundStyle(Palette.fg)
                    .accessibilityIdentifier(AID.voicesUndo)
            }
        }
        .font(.line)
    }

    /// One moment in a tinted box: the clip, then, with more clips, "Another moment".
    private func moment(_ check: Check) -> some View {
        let shown = check.clips[clip % check.clips.count].trimmed()
        return VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            ReadAlong(clip: shown).id("\(check.ref)-\(clip)")
            if check.clips.count > 1 {
                Button("Another moment") { clip += 1 }.font(.line).fontWeight(.semibold).foregroundStyle(Palette.fg)
                    .identified(AID.voicesAnother).padding(.leading, Metrics.tapTarget + Metrics.Spacing.m)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.tint, in: .rect(cornerRadius: 18))
    }

    // MARK: Answers

    private func answers(_ check: Check) -> some View {
        let guess = suggestion(check)
        return VStack(spacing: Metrics.Spacing.s) {
            if let guess {
                let name = guess.isOwner ? "me" : String(guess.name.split(separator: " ").first ?? "")
                pill("It’s \(name)", .filled, id: "is-them", isFull: true) {
                    let option = check.options.first { $0.id == "is-them" }
                    Task { await life.answerVoice(check, option.flatMap(check.answer), who: guess.name) }
                }
            } else {
                pill("Say who it is", .filled, id: "else", isFull: true) { startNaming(check) }
            }
            HStack(spacing: Metrics.Spacing.s) {
                if guess != nil { pill("Someone else", .quiet, id: "else") { startNaming(check) } }
                pill("Not a person", .quiet, id: "media") {
                    Task { await life.answerVoice(check, check.answerMedia, who: nil) }
                }
                pill("Later", .quiet, id: "later") { Task { await life.later(check.ref) } }
            }
        }
    }

    /// Life's one suggestion: the person its Yes names.
    private func suggestion(_ check: Check) -> Party? {
        check.options.contains { $0.id == "is-them" } ? check.likelyPeople.first : nil
    }

    /// A pill filling its share of the row (the prototype's full-width answers).
    private func pill(
        _ title: String, _ kind: PillStyle.Kind, id: String, isFull: Bool = false, action: @escaping () -> Void
    ) -> some View {
        let isFilled = kind == .filled
        return Button(action: action) {
            Text(title).font(.heading).lineLimit(typeSize > .large ? nil : 1).foregroundStyle(
                isFilled ? Palette.on : Palette.fg
            )
            .minimumScaleFactor(0.8).padding(.horizontal, Metrics.Spacing.s).frame(
                maxWidth: .infinity, minHeight: isFull ? 48 : 44
            )
            .background(isFilled ? Palette.fg : Palette.tint, in: .capsule)
        }
        .buttonStyle(.plain).identified(AID.voicesAnswer(id))
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
                            check, check.answer(naming: .name(typed)), who: typed)
                    }
                }
            }
            HStack(spacing: Metrics.Spacing.s) {
                pill("Back", .quiet, id: "back", isFull: true) { life.naming = nil }
                pill("Leave unnamed", .quiet, id: "unnamed", isFull: true) {
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
                face.frame(width: 36, height: 36).background(Palette.fg.opacity(Metrics.Opacity.wash), in: .circle)
                Text(name).font(.bodyStrong).fontWeight(.semibold).lineLimit(typeSize > .large ? nil : 1)
                Spacer(minLength: 0)
                if let note { Text(note).font(.line).foregroundStyle(Palette.muted) }
            }
            .padding(.leading, 6).padding(.trailing, 14).frame(minHeight: 48).background(Palette.tint, in: .capsule)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain).identified(AID.voicesPerson(id))
    }
}
