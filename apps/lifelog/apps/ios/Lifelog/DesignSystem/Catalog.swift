import SwiftUI

#if DEBUG
    /// Every component in every state, on the dark page (Debug only: `-catalog` on launch, or the previews). Screens
    /// are built from what is shown here, and a component not here is not in the design system.
    struct CatalogView: View {
        @State private var state = EdgeState.rest
        @State private var colour: Int?
        @State private var opened: Set<Int> = [0]
        @State private var position: ScrollPosition
        private let page: String

        /// `scrolled` is where the page starts, for screenshots of a long page in screen-sized steps.
        init(page: String = "", scrolled: CGFloat = 0) {
            self.page = page
            _position = State(initialValue: ScrollPosition(y: scrolled))
        }

        var body: some View {
            ZStack {
                Palette.bg.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                        if show("values") { values }
                        if show("blocks") { blocks }
                        if show("thread") { thread }
                        if show("items") { items }
                        if show("asks") { asks }
                        if show("settings") { settings }
                        if show("aura") { aura }
                    }
                    .padding(.horizontal, Metrics.gutter).padding(.vertical, Metrics.Spacing.xl)
                    // A standard iPhone's width, so the catalog reads the same on the Duo's wider screen.
                    .frame(maxWidth: 393).frame(maxWidth: .infinity)
                }
                .scrollPosition($position)
                if show("aura") { EdgeView(state: state, aura: AuraSetting(colour: colour)) }
            }
            .foregroundStyle(Palette.fg).font(.body15).preferredColorScheme(.dark)
        }

        private func show(_ name: String) -> Bool { page.isEmpty || page == name }

        private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
            VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                Text(title).font(.heading).foregroundStyle(Palette.muted)
                content()
            }
        }

        // MARK: Values

        private var values: some View {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                section("Colour") {
                    swatches([
                        ("bg", Palette.bg), ("card", Palette.card), ("tile", Palette.tile), ("paper", Palette.paper),
                        ("line", Palette.line), ("fg", Palette.fg), ("muted", Palette.muted), ("faint", Palette.faint),
                        ("flag", Palette.flag), ("ai", Palette.ai), ("ok", Palette.ok), ("on", Palette.on),
                        ("tint", Palette.tint), ("glass", Palette.glass), ("wash", Palette.wash),
                    ])
                }
                section("The aura's colours") { swatches(Palette.auraColours.map { ($0.name, $0.color) }) }
                section("Type") {
                    Text("Sara Lindqvist").font(.profileName)
                    Text("Reservation for four").font(.header)
                    Text("Lunch with Julien").font(.rowTitle)
                    Text("Sunday at 10:00, if that still works for you.").font(.body15)
                    Text("Two replies since Friday").font(.line).foregroundStyle(Palette.muted)
                    Text("Earlier").font(.heading).foregroundStyle(Palette.muted)
                    Text("14:18 · WhatsApp").font(.meta).foregroundStyle(Palette.faint)
                }
                section("Radius: control 12, block 18, sheet 22, button a full pill") {
                    HStack(spacing: Metrics.Spacing.m) {
                        ForEach([Metrics.Radius.control, Metrics.Radius.block, Metrics.Radius.sheet], id: \.self) { r in
                            RoundedRectangle(cornerRadius: r).fill(Palette.card).frame(height: 64)
                        }
                        Capsule().fill(Palette.card).frame(height: 64)
                    }
                }
            }
        }

        private func swatches(_ list: [(String, Color)]) -> some View {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 72), spacing: Metrics.Spacing.s)], spacing: Metrics.Spacing.m
            ) {
                ForEach(list, id: \.0) { name, color in
                    VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                        RoundedRectangle(cornerRadius: Metrics.Radius.control).fill(color).frame(height: 40)
                        Text(name).font(.meta).foregroundStyle(Palette.muted)
                    }
                }
            }
        }

        // MARK: Building blocks

        private var blocks: some View {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                section("Buttons: filled, quiet, done, busy, disabled") {
                    HStack {
                        Button("Yes") {}.buttonStyle(.pill(.filled, size: .compact))
                        Button("No") {}.buttonStyle(.pill(.quiet, size: .compact))
                        Button {
                        } label: {
                            Image(systemName: "checkmark")
                        }.buttonStyle(.pill(.done, size: .compact))
                    }
                    HStack {
                        Button("Sending") {}.buttonStyle(.pill(.filled, size: .compact, isBusy: true))
                        Button("Later") {}.buttonStyle(.pill(.quiet, size: .compact)).disabled(true)
                    }
                }
                section("Chips") {
                    HStack {
                        QuietChip("Warmer") {}; QuietChip("Shorter", isMuted: true) {};
                        QuietChip("In French", isBusy: true) {}
                    }
                }
                section("Round buttons") {
                    HStack(spacing: Metrics.Spacing.m) {
                        RoundButton(symbol: "tray", label: "What waits on you", badge: 3) {}
                        RoundButton(symbol: "waveform.badge.mic", label: "Pendant") {}
                        RoundButton(symbol: "stop.fill", label: "Stop") {}
                    }
                }
                section("Block surface, wash, still ring") {
                    HStack(spacing: Metrics.Spacing.l) {
                        Text("A block").padding().card()
                        Text("Unfolded").padding().background(
                            Palette.wash, in: .rect(cornerRadius: Metrics.Radius.block))
                        StillRing(progress: 0.25); StillRing(progress: 0.5); StillRing(progress: 1)
                    }
                }
            }
        }

        // MARK: Thread

        private var thread: some View {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                section("His bubble: sent, with 👀, with 👍, waiting, not sent") {
                    VStack(spacing: Metrics.Spacing.s) {
                        HisBubble(words: "Book a physio near home")
                        HisBubble(words: "Book a physio near home", reaction: .handedOn)
                        HisBubble(words: "Lunch on Sunday at 10:00", reaction: .up)
                        HisBubble(words: "Tell Lena I'm late", state: .waiting)
                        HisBubble(words: "Tell Lena I'm late", state: .failed)
                    }
                }
                section("Earlier draft") { EarlierDraftRow(words: "Hi Lena, I'll be late, sorry!") }
                section("Life's line, then the answer") {
                    Text("I'm on it. About 20 min.")
                    Text("Sunday at 10:00.")
                }
                section("Reactions: handed on, done, and the rating's three") {
                    HStack(spacing: Metrics.Spacing.l) {
                        ForEach(Reaction.allCases, id: \.self) { ReactionMark(reaction: $0).font(.header) }
                    }
                }
                section("How am I doing?") { RatingRow() }
                section("Sent line: Undo, confirm, undoing, deleted") {
                    VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                        SentLine(to: "Lena", phase: .sent(undoUntil: "Fri"))
                        SentLine(
                            to: "Lena",
                            phase: .confirming(
                                "Lena will see “This message was deleted”, and may already have read it."))
                        SentLine(to: "Lena", phase: .undoing)
                        SentLine(to: "Lena", phase: .undone)
                        SentLine(to: "Lena", phase: .sent(undoUntil: nil))
                    }
                }
                section("Held asks") { HeldSeparator(text: "While you were in your meeting · 14:00 to 15:00") }
                section("Notice: closed, open, back") {
                    VStack(spacing: Metrics.Spacing.s) {
                        NoticeBlock(title: "Your Mac isn't answering")
                        NoticeBlock(
                            title: "Your Mac isn't answering", message: "It has not answered for 12 minutes.",
                            action: "Settings",
                            isOpen: true)
                        Text("Back · 2 sent").font(.line).foregroundStyle(Palette.muted)
                    }
                }
            }
        }

        // MARK: Items

        private var items: some View {
            let states: [(String, ItemState)] = [
                ("Reply to Sara about Sunday", .needsYou), ("Renew the passport", .later),
                ("Find a physio near home", .underWay(progress: 0.4, estimate: "About 10 min left")),
                ("Waiting for the landlord", .waitingOnSomeone), ("Book the dentist", .settled),
                ("Tell Lena I'm late", .undone("Deleted for both of you")), ("Old plan for Friday", .outdated),
                ("Send the invoice", .queued), ("Look for a flat", .stopped),
            ]
            return section("Thread item: every state; the first one unfolded") {
                VStack(spacing: 0) {
                    ForEach(Array(states.enumerated()), id: \.offset) { i, item in
                        ThreadItemRow(
                            title: item.0, state: item.1, isOpen: opened.contains(i),
                            toggle: { if !opened.insert(i).inserted { opened.remove(i) } }
                        ) {
                            AskCard(
                                question: "Reply to Sara?", why: "She asked on Friday.", answers: ["Yes", "No"],
                                recommended: "Yes")
                        }
                    }
                }
            }
        }

        // MARK: Asks

        private var asks: some View {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                section("Ask card: plain, with a draft and quick edits, a spending stop") {
                    AskCard(
                        question: "Move lunch to Sunday?", why: "Julien can't do Saturday.", answers: ["Yes", "No"],
                        recommended: "Yes")
                    AskCard(
                        question: "Reply to Lena?", draft: "Hi Lena, I'll be there by 10:15. Sorry!",
                        edits: ["Warmer", "Shorter", "In French"], answers: ["Send", "Not now"], recommended: "Send")
                    AskCard(
                        question: "Keep looking for a physio?", why: "Two places are still booked up.",
                        amounts: "About 1 € more · 1 € so far", answers: ["Keep looking", "Stop here"])
                    AskCard(
                        question: "Reply to Lena?", answers: ["Send"], recommended: "Send", isBusy: true)
                }
                section("Question in an answer, and an offer") {
                    QuestionBlock(answers: ["Sunday", "Saturday", "Neither"], recommended: "Sunday")
                    OfferBlock(question: "Stop telling you about newsletters?")
                }
                section("Answer blocks: document, phrase, place") {
                    VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                        Text("Invoice 214").font(.rowTitle)
                        Text("Physio, 3 sessions").font(.line).foregroundStyle(Palette.muted)
                        Text("180 €").font(.rowTitle)
                    }
                    .padding(Metrics.Spacing.l).frame(maxWidth: .infinity, alignment: .leading).card()
                    VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                        Text("Où est la gare ?").font(.quote)
                        Text("Where is the station?").font(.line).foregroundStyle(Palette.muted)
                    }
                    .padding(Metrics.Spacing.l).frame(maxWidth: .infinity, alignment: .leading).card()
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Café Lune").font(.rowTitle)
                        Text("12 Rue Neuve, Lille").font(.line).foregroundStyle(Palette.muted)
                    }
                    .padding(Metrics.Spacing.l).frame(maxWidth: .infinity, alignment: .leading).card()
                }
            }
        }

        // MARK: Settings

        private var settings: some View {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                section("Settings block: switches, value pills, a tick after a change") {
                    SettingsBlock {
                        SettingSwitchRow(title: "Face ID before Send", isOn: true)
                        Hairline()
                        SettingSwitchRow(title: "Newsletters", isOn: false, isTicked: true)
                        Hairline()
                        SettingValueRow(title: "Appearance", choices: ["Auto", "Dark"], selection: "Dark")
                        Hairline()
                        SettingValueRow(
                            title: "Monthly spend", choices: ["10 €", "25 €", "50 €"], selection: "25 €", isTicked: true
                        )
                    }
                }
            }
        }

        // MARK: Aura

        private var aura: some View {
            section("The aura: pick a state and a colour; the edge shows it") {
                Picker("State", selection: $state) {
                    Text("Idle").tag(EdgeState.rest)
                    Text("You speak").tag(EdgeState.speaking)
                    Text("Working").tag(EdgeState.working)
                    Text("No Mac").tag(EdgeState.still)
                }
                .pickerStyle(.segmented)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Metrics.Spacing.s) {
                        swatchButton(nil, Palette.ai)
                        ForEach(Array(Palette.auraColours.enumerated()), id: \.offset) {
                            swatchButton($0.offset, $0.element.color)
                        }
                    }
                }
            }
        }

        private func swatchButton(_ index: Int?, _ color: Color) -> some View {
            Button {
                colour = index
            } label: {
                Circle().fill(color).frame(width: 32, height: 32)
                    .overlay {
                        if colour == index {
                            Image(systemName: "checkmark").font(.lineStrong).foregroundStyle(Palette.on)
                        }
                    }
                    .frame(width: Metrics.tapTarget, height: Metrics.tapTarget)
            }
            .buttonStyle(.plain)
        }
    }

    #Preview("Catalog") { CatalogView() }
#endif
