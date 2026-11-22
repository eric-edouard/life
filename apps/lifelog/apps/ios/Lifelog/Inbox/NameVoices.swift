import LifeConnector
import SwiftUI

/// The way into the voice run (`InboxOrder.folded`: the voices to name are one card): how many, about how long, and one
/// Start. Nothing here is ticked, played or answered.
struct VoiceRunEntry: View {
    let voices: [Check]
    let start: () -> Void

    var body: some View {
        let minutes = max(1, (voices.count + 2) / 3)
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            Text("\(voices.count) voice\(voices.count == 1 ? "" : "s") to name").font(.cardQuestion)
                .foregroundStyle(Palette.fg).accessibilityAddTraits(.isHeader)
            Text("About \(minutes) minute\(minutes == 1 ? "" : "s"), one after another").font(.small)
                .foregroundStyle(Palette.muted)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Metrics.Spacing.s).padding(.vertical, Metrics.Spacing.m).readingWidth()
        .safeAreaBar(edge: .bottom, spacing: 0) {
            Button("Start", action: start).buttonStyle(.pill(.filled))
                .padding(.horizontal, Metrics.Spacing.s).padding(.bottom, Metrics.Spacing.s).readingWidth()
                .frame(maxWidth: .infinity).background { AnswersBackdrop() }
        }
    }
}

/// Naming voices, one after another (his direction of 22 Nov, "the player"): a screen of its own, one voice at a time.
/// The clip plays as the voice lands; he taps one answer, which works on its button, turns green on Life's word and then
/// slides the next voice in. Nothing is chosen for him: "Don't name" is never a default. A failure keeps him on the voice,
/// with Life's reason above the answers. The voices are those the run began with; each answer is its own `answer_check`.
struct NameVoicesRun: View {
    let voices: [Check]
    let close: () -> Void

    @Environment(LifeStore.self) private var life
    @State private var at = 0
    /// Each voice's answer in his words; a voice with none was skipped and stays in Waiting on you.
    @State private var named: [String: String] = [:]
    /// People named in this run, first among the next voice's guesses.
    @State private var recent: [Party] = []
    @State private var phase = Phase.idle
    @State private var failure: String?
    @State private var isPickingPerson = false

    private enum Phase: Equatable {
        case idle, working(String), saved(String)
        var id: String? {
            switch self {
            case .idle: nil
            case .working(let id), .saved(let id): id
            }
        }
    }

    private var isOver: Bool { at >= voices.count }

    var body: some View {
        VStack(spacing: 0) {
            header
            ZStack {
                if isOver {
                    end.transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                } else {
                    step(voices[at]).id(at)
                        .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                }
            }
            .clipped()
        }
        .background(Palette.bg)
        .task { await life.refreshPeople() }
    }

    // MARK: Header: × | progress | Skip

    private var header: some View {
        HStack(spacing: Metrics.Spacing.m) {
            CloseButton(close: close)
            Capsule().fill(Color.fillTint).frame(height: 4)
                .overlay(alignment: .leading) {
                    GeometryReader { box in
                        Capsule().fill(Palette.fg).frame(width: box.size.width * progress)
                    }
                }
                .accessibilityElement().accessibilityLabel("Voice \(min(at + 1, voices.count)) of \(voices.count)")
            if !isOver {
                Button(action: next) {
                    Label("Skip", systemImage: "forward.end").labelStyle(.titleAndIcon)
                }
                .buttonStyle(.pill(.quiet, size: .compact)).frame(width: 96).disabled(phase != .idle)
            }
        }
        .padding(.horizontal, Metrics.Spacing.s).padding(.vertical, Metrics.Spacing.xs)
        .motion(Motion.standard, value: at)
    }

    private var progress: Double { voices.isEmpty ? 1 : Double(at) / Double(voices.count) }

    // MARK: One voice

    private func step(_ check: Check) -> some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            if !check.clips.isEmpty { VoiceBlock(clips: check.clips, autoplays: true) }
            Spacer(minLength: 0)
            Text("Who is this?").font(.cardQuestion).foregroundStyle(Palette.fg)
                .accessibilityAddTraits(.isHeader)
            // Reserved, so a failure never moves the answers.
            Text(failure ?? " ").font(.small).foregroundStyle(Palette.flag).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            answers(for: check)
        }
        .padding(.horizontal, Metrics.Spacing.s).padding(.bottom, Metrics.Spacing.s).readingWidth()
        .sheet(isPresented: $isPickingPerson) {
            SameAsSheet(
                people: check.peopleToPick(among: people), takesNewName: true, createsBySheet: false, cardName: nil,
                choose: { choice in
                    guard let request = check.answer(naming: choice) else { return }
                    switch choice {
                    case .person(let ref):
                        let who = people.first { $0.ref == ref }
                        send(request, as: who?.name ?? "Someone", id: "someone", who: who, on: check)
                    case .name(let name): send(request, as: name, id: "someone", who: nil, on: check)
                    }
                }, create: { _ in }
            )
            .sheetStack()
        }
    }

    private var people: [Party] { life.people.value?.people.map(\.party) ?? [] }

    /// Always in this order: Me; the guesses; Someone else…; TV or video beside Don't name.
    private func answers(for check: Check) -> some View {
        VStack(spacing: Metrics.Spacing.s) {
            if let me = check.answerMe {
                answer("me", "Me", lead: .disc("Me")) { send(me, as: "Me", id: "me", who: nil, on: check) }
            }
            ForEach(check.voiceGuesses(recent: recent).prefix(2), id: \.ref) { who in
                answer(
                    who.ref, who.name, why: recent.contains { $0.ref == who.ref } ? "Just now" : who.line,
                    lead: .disc(who.name)
                ) {
                    if let request = check.answer(naming: .person(who.ref)) {
                        send(request, as: who.name, id: who.ref, who: who, on: check)
                    }
                }
            }
            answer("someone", "Someone else…", lead: .symbol("person")) { isPickingPerson = true }
            HStack(spacing: Metrics.Spacing.s) {
                answer("media", "TV or video", lead: .symbol("tv")) {
                    send(check.answerMedia, as: "TV or video", id: "media", who: nil, on: check)
                }
                answer("dont", "Don’t name", lead: .symbol("eye.slash")) {
                    send(check.answerDontName, as: "Not named", id: "dont", who: nil, on: check)
                }
            }
        }
    }

    private enum Lead {
        case disc(String), symbol(String)
    }

    /// One answer: a 54 pill, its slot at the left. The one he pressed works, then is green; the rest dim until it ends.
    private func answer(
        _ id: String, _ label: String, why: String? = nil, lead: Lead, run: @escaping () -> Void
    ) -> some View {
        let isPressed = phase.id == id
        let isSaved = isPressed && phase == .saved(id)
        return Button(action: run) {
            HStack(spacing: Metrics.Spacing.s) {
                Group {
                    if isSaved {
                        Image(systemName: "checkmark")
                    } else {
                        switch lead {
                        case .disc(let name): PartyDisc(name: name, size: .pick)
                        case .symbol(let name): Image(systemName: name)
                        }
                    }
                }
                .frame(width: 30)
                VStack(alignment: .leading, spacing: 0) {
                    Text(label).font(.buttonLabel)
                    if let why, !isPressed { Text(why).font(.small).foregroundStyle(Palette.ai).lineLimit(1) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .buttonStyle(.pill(isSaved ? .done : .quiet, size: .large, isBusy: isPressed && !isSaved))
        .opacity(phase == .idle || isPressed ? 1 : 0.35).disabled(phase != .idle)
        .offWhileOutOfReach()
    }

    /// His answer, through `answer_check` like every other: green on Life's word, then the next voice; else the reason,
    /// on this voice.
    private func send(_ request: AnswerRequest, as words: String, id: String, who: Party?, on check: Check) {
        guard phase == .idle, !life.saysOutOfReach() else { return }
        (phase, failure) = (.working(id), nil)
        life.forget(.answer(ref: check.ref))
        Task {
            await life.answer(request)
            guard let said = life.state(of: .answer(ref: check.ref)).heldAnswerWords(as: words), said.isDone else {
                let why = life.state(of: .answer(ref: check.ref)).heldAnswerWords(as: words)?.words
                (phase, failure) = (.idle, "Not saved: \(why ?? "Life did not answer.")")
                return
            }
            withAnimation(Motion.standard) { phase = .saved(id) }
            named[check.ref] = words
            if let who, !recent.contains(where: { $0.ref == who.ref }) { recent.insert(who, at: 0) }
            try? await Task.sleep(for: .seconds(0.35))
            next()
        }
    }

    private func next() {
        withAnimation(Motion.standard) {
            at += 1
            (phase, failure) = (.idle, nil)
        }
    }

    // MARK: The end

    private var end: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            Text(named.isEmpty ? "Nothing named" : "\(named.count) voice\(named.count == 1 ? "" : "s") named")
                .font(.cardQuestion).foregroundStyle(Palette.fg).accessibilityAddTraits(.isHeader)
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(voices) { check in
                        let answer = named[check.ref]
                        VStack(alignment: .leading, spacing: 2) {
                            Text(check.clips.first.map { "“\($0.text)”" } ?? check.question).font(.lead)
                                .foregroundStyle(Palette.fg).lineLimit(1)
                            Text(answer ?? "Skipped, still to name").font(.small)
                                .foregroundStyle(answer == nil ? Palette.flag : Palette.muted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, Metrics.Spacing.s)
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            Button("Done", action: close).buttonStyle(.pill(.filled))
        }
        .padding(.horizontal, Metrics.Spacing.s).padding(.bottom, Metrics.Spacing.s).readingWidth()
    }
}
