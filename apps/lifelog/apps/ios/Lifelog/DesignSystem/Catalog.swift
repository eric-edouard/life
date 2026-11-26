import LifeConnector
import Library
import SwiftUI

#if DEBUG
    /// Every component in every state, on the dark page (Debug only: `-catalog` on launch, or the previews). Screens
    /// are built from what is shown here, and a component not here is not in the design system.
    struct CatalogView: View {
        @State private var state = CatalogView.launchState
        @State private var colour = 0
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
                    .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.xl)
                    // A standard iPhone's width, so the catalog reads the same on the Duo's wider screen.
                    .frame(maxWidth: Metrics.phoneWidth).frame(maxWidth: .infinity)
                }
                .scrollPosition($position)
                if show("aura") { EdgeView(state: state, aura: AuraSetting(colour: colour)) }
            }
            .foregroundStyle(Palette.fg).font(.body15).preferredColorScheme(.dark)
        }

        /// `-auraState still` starts the aura page on that state, for screenshots.
        private static var launchState: EdgeState {
            let named = CommandLine.arguments.drop { $0 != "-auraState" }.dropFirst().first
            return stateNames.first { $0.value.lowercased().replacingOccurrences(of: " ", with: "") == named }?.key
                ?? .rest
        }

        private static let sample: CGFloat = 64

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
                section("The aura's ten colours") { swatches(AuraSetting.choices.map { ($0.name, $0.color) }) }
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
                            RoundedRectangle(cornerRadius: r).fill(Palette.card).frame(height: Self.sample)
                        }
                        Capsule().fill(Palette.card).frame(height: Self.sample)
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
                        RoundedRectangle(cornerRadius: Metrics.Radius.control).fill(name == "on" ? Palette.fg : color)
                            .frame(height: Metrics.disc)
                            .overlay { if name == "on" { Circle().fill(color).padding(Metrics.Spacing.s) } }
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
                section("Block surface, wash, still pie") {
                    HStack(spacing: Metrics.Spacing.l) {
                        Text("A block").padding().card()
                        Text("A wash").padding().background(Palette.wash)
                        StillRing(progress: 0.25); StillRing(progress: 0.5); StillRing(progress: 1)
                    }
                }
            }
        }

        // MARK: Thread

        private var thread: some View {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                section("His bubble: sent, with a reaction, waiting, not sent") {
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
                section("Reactions: handed on, and the rating's three") {
                    HStack(spacing: Metrics.Spacing.l) {
                        ForEach(Reaction.allCases, id: \.self) { ReactionMark(reaction: $0).font(.header) }
                    }
                }
                section("How am I doing? Marks: bad, okay, good (one \"rated\" line); a tap on one closes the row") {
                    RatingRow()
                }
                section("Work handed on: the pie and the time left; Life at work: a step, or thinking") {
                    VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                        HandedLine(progress: 0.4, estimate: "About 10 min left")
                        StepsLine(verb: "Looking at", what: "your calendar")
                        StepsLine()
                    }
                }
                section("Sent line: Undo, confirm, undoing, deleted") {
                    VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                        SentLine(to: "Lena", phase: .sent(canUndo: true, until: "Fri"))
                        SentLine(
                            to: "Lena",
                            phase: .confirming(
                                "Lena will see “This message was deleted”, and may already have read it."))
                        SentLine(to: "Lena", phase: .undoing)
                        SentLine(to: "Lena", phase: .undone)
                        SentLine(to: "Lena", phase: .sent(canUndo: false))
                    }
                }
                section("Held asks") { HeldSeparator(text: "While you were in your meeting · 14:00 to 15:00") }
                section("Notice: closed, open with its settings, back") {
                    VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                        NoticeBlock(title: "Your Mac isn't answering · since 10:42", symbol: "desktopcomputer")
                        NoticeBlock(
                            title: "You're offline · since 15:40", symbol: "wifi.slash", isOpen: true
                        ) {
                            SettingsBlock {
                                SettingSwitchRow(title: "Tell me when it is back", isOn: true)
                            }
                        }
                        Text("Back · 2 sent").font(.line).foregroundStyle(Palette.muted)
                    }
                }
            }
        }

        // MARK: Items

        private var items: some View {
            let states: [(String, String, ItemState, String?)] = [
                ("Reply to Sara about Sunday", "bubble.left", .needsYou, "Sara · today"),
                ("Renew the passport", "doc", .later, "Later · tomorrow 9:00"),
                (
                    "Find a physio near home", "figure.walk", .underWay(progress: 0.4, estimate: "About 10 min left"),
                    nil
                ),
                ("Waiting for the landlord", "house", .waitingOnSomeone, "Waiting for a reply · Thu"),
                ("Book the dentist", "calendar", .settled, "Done"),
                ("Tell Lena I'm late", "bubble.left", .undone("Deleted for both of you"), nil),
                ("Old plan for Friday", "calendar", .outdated, "Sara wrote since"),
                ("Send the invoice", "envelope", .queued, "Goes when you're back"),
                ("Look for a flat", "building.2", .stopped, nil),
            ]
            return section("Thread item: every state; the first one unfolded") {
                VStack(spacing: Metrics.Spacing.xs) {
                    ForEach(Array(states.enumerated()), id: \.offset) { i, item in
                        ThreadItemRow(
                            title: item.0, state: item.2, icon: item.1, line: item.3, isOpen: opened.contains(i),
                            toggle: { if !opened.insert(i).inserted { opened.remove(i) } }
                        ) {
                            AskCard(
                                question: "Reply to Sara?", why: "She asked on Friday.", answers: ["Yes", "No"],
                                recommended: "Yes", isInItem: true)
                        }
                    }
                }
            }
        }

        // MARK: Asks

        private var asks: some View {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                section("Ask card: plain, a spending stop, busy (on a wash, full bleed)") {
                    VStack(spacing: Metrics.Spacing.m) {
                        AskCard(
                            question: "Move lunch to Sunday?", why: "Julien can't do Saturday.",
                            answers: ["Yes", "No"], recommended: "Yes")
                        AskCard(
                            question: "Keep looking for a physio?", why: "Two places are still booked up.",
                            amounts: "About 1 € more · 1 € so far", answers: ["Keep looking", "Stop here"],
                            recommended: "Keep looking")
                        AskCard(
                            question: "Reply to Lena?", answers: ["Send", "Edit"], recommended: "Send", busy: "Send")
                    }
                    .padding(.horizontal, -Metrics.Spacing.l)
                }
                section("Ask card with its draft, in each app: WhatsApp, Messages, mail, sent") {
                    VStack(spacing: Metrics.Spacing.m) {
                        AskCard(
                            question: "Reply to Lena?", check: Self.draft("whatsapp"),
                            edits: ["Warmer", "Shorter", "In French"], answers: ["Send"], recommended: "Send"
                        )
                        AskCard(
                            question: "Reply to Lena?", check: Self.draft("imessage"), answers: ["Send"],
                            recommended: "Send")
                        AskCard(
                            question: "Send this to Helene?", check: Self.draft("mail", isMail: true),
                            answers: ["Send"], recommended: "Send")
                        if let sent = DraftBlock(check: Self.draft("whatsapp"), delivery: .sent, isBoxed: false) {
                            sent.padding(.horizontal, Metrics.Spacing.l)
                        }
                    }
                    .padding(.horizontal, -Metrics.Spacing.l)
                }
                section("Question in an answer, and an offer") {
                    QuestionBlock(answers: ["Sunday", "Saturday", "Neither"], recommended: "Sunday")
                    OfferBlock(question: "Stop telling you about newsletters?")
                }
                section(#"A draft's quick edits: a tap ("edit:tap"), or his words ("edit:words")"#) {
                    EditChips(edits: ["Warmer", "Shorter", "In French"])
                }
                section("Answer blocks: document, table, phrase, place") {
                    DocumentBlock(title: "Invoice 214", lines: ["Physio, 3 sessions"], total: "180 €")
                    TableBlock(columns: ["Bags", "Seed"], rows: [["#420", "3"], ["#455", "4"]], total: "7")
                    PhraseBlock(text: "Où est la gare ?", mine: "Where is the station?")
                    PlaceBlock(name: "Café Lune", address: "12 Rue Neuve, Lille")
                }
            }
        }

        /// A made-up card carrying a draft to Lena (or Helene, for mail), as the connector sends it.
        private static func draft(_ channel: String, isMail: Bool = false) -> Check {
            let who = #""sender":{"kind":"person","name":"Lena Moreau","ref":"person:inf_lena"}"#
            let recent =
                #"[{"at":"2026-11-25T09:00:00.000Z",\#(who),"text":"Are you still coming Sunday?"}]"#
            let draft =
                isMail
                ? #"{"to":"Helene","channel":"mail","from":"me@example.test","subject":"Re: Lease","text":"Signed, attached."}"#
                : #"{"to":"Lena","channel":"\#(channel)","text":"Yes, I'll be there by 10:15. Sorry!","recent":\#(recent)}"#
            let json =
                #"{"ref":"dec_catalog","group":"decision","title":"Reply","question":"Send this?","asker":"desk","#
                + #""options":[],"clips":[],"likelyPeople":[],"links":[],"draft":\#(draft)}"#
            // The JSON is this file's own; it decodes or the catalog is wrong.
            guard let check = try? LibraryStore.feedDecoder.decode(Check.self, from: Data(json.utf8)) else {
                preconditionFailure("the catalog's own card does not decode")
            }
            return check
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
                SegmentedChoice(
                    choices: [EdgeState.rest, .speaking, .working, .still],
                    selection: Binding(get: { state }, set: { state = $0 ?? state }),
                    title: { Self.stateNames[$0] ?? "" })
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: Metrics.tapTarget), spacing: Metrics.Spacing.s)],
                    spacing: Metrics.Spacing.s
                ) {
                    ForEach(Array(AuraSetting.choices.enumerated()), id: \.offset) {
                        swatchButton($0.offset, $0.element.color)
                    }
                }
                Text(AuraSetting.choices[colour].name).font(.line).foregroundStyle(Palette.muted)
            }
        }

        private static let stateNames: [EdgeState: String] = [
            .rest: "Idle", .speaking: "You speak", .working: "Working", .still: "No Mac",
        ]

        private func swatchButton(_ index: Int, _ color: Color) -> some View {
            Button {
                colour = index
            } label: {
                Circle().fill(color).frame(width: Metrics.swatch, height: Metrics.swatch)
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
