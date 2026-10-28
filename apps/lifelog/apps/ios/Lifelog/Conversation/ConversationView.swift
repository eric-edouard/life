import Library
import SwiftUI
import Timeline
import UIKit

/// Opens one conversation, optionally at an exact capture instant (a search match): the page scrolls there and the
/// player is set to that moment. Previous and next in the player carry the page along to that conversation.
struct ConversationView: View {
    let id: UUID
    var at: CaptureInstant?

    @Environment(SyncStore.self) private var sync: SyncStore?
    @Environment(\.library) private var library
    @Environment(PlaybackStore.self) private var playback
    @State private var store: ConversationStore

    init(id: UUID, at: CaptureInstant? = nil) {
        self.id = id
        self.at = at
        store = ConversationStore(id: id)
    }

    var body: some View {
        ConversationContent(store: store, at: at)
            .id(store.id)
            // Loads again when the player moves to another conversation, or the driver applied the feed or an edit
            // went out (words, speakers, a summary, a title); SwiftUI cancels the older load, so it never lands last.
            .task(id: [store.id.uuidString, "\(sync?.generation ?? 0)"]) {
                store.sync = sync
                store.library = library
                await store.load()
            }
            .timesFirstRender("conversation", ready: store.phase == .loaded, rows: store.lines.count)
            // The player moved on from this conversation (previous/next, the lock screen): the page follows.
            .onChange(of: playback.item?.id) { old, new in
                guard old == store.id, let new, new != store.id else { return }
                store = ConversationStore(id: new)
            }
    }
}

/// The reader: the transcript is the page. While this conversation plays, the passage being spoken is highlighted
/// and followed until the owner scrolls by hand; a glass player floats at the bottom. Previews drive it with
/// fixture content.
struct ConversationContent: View {
    let store: ConversationStore
    var at: CaptureInstant?

    @Environment(PlaybackStore.self) private var playback
    @State private var reading = ReadAlong()
    @State private var copied = false
    @State private var openedAt = false
    @State private var titleInBar = false
    @State private var renaming = false
    @State private var draftTitle = ""
    @Namespace private var dockGlass
    @Namespace private var highlight

    var body: some View {
        @Bindable var store = store
        Group {
            switch store.phase {
            case .loading:
                ProgressView("Loading conversation")
            case .missing:
                ContentUnavailableView(
                    "Conversation not found", systemImage: "questionmark.bubble",
                    description: Text("It may have been split or merged since this link was made."))
            case .loaded:
                if let conversation = store.conversation {
                    ScrollViewReader { proxy in
                        page(conversation, proxy)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.ground)
        .navigationTitle(shownTitle ?? "Conversation")
        .navigationBarTitleDisplayMode(.inline)
        // The page's own player is the only one while it shows: the mini player hides.
        .onAppear { playback.pagesOnScreen += 1 }
        .onDisappear { playback.pagesOnScreen -= 1 }
        .toolbar { toolbar }
        .sensoryFeedback(.success, trigger: copied) { _, copied in copied }
        .task(id: copied) {
            guard copied, (try? await Task.sleep(for: .seconds(1.6))) != nil else { return }
            copied = false
        }
        .alert("Couldn't do that", item: $store.failure) { _ in
            Button("OK") {}
        } message: { failure in
            Text(failure)
        }
        .alert("Rename", isPresented: $renaming) {
            TextField("Title", text: $draftTitle)
            Button("Save") { Task { await store.rename(draftTitle) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your title always wins over a generated one. Leave it empty to use the generated one.")
        }
        .fullScreenCover(item: $store.viewing) { PhotoViewer(photos: store.photos, start: $0) }
        .confirmationDialog("Split this conversation here?", item: $store.splitting) { line in
            Button("Split here", role: .destructive) { Task { await store.split(at: line) } }
        } message: { line in
            let offset = store.conversation.map { $0.range.lowerBound.distance(to: line.start) } ?? 0
            Text("Everything from \(PlayerClock.string(offset)) on becomes a new conversation. No audio is lost.")
        }
    }

    /// A plain list, not a lazy stack: it reuses rows (and their text views) and jumps to a far passage from estimated
    /// heights instead of measuring every passage on the way.
    private func page(_ conversation: CachedConversation, _ proxy: ScrollViewProxy) -> some View {
        let origin = conversation.range.lowerBound
        return List {
            Group {
                ConversationHeader(store: store, conversation: conversation)
                    .padding(.top, 4)
                TranscriptStatus(store: store)
                SplitNotes(store: store)
                ForEach(store.blocks) { block in
                    TranscriptBlockView(
                        block: block, store: store, reading: reading, origin: origin,
                        highlight: highlight)
                }
            }
            .listRowInsets(EdgeInsets(top: 1, leading: 16, bottom: 1, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            // As outside a list: list rows otherwise give labels a cell's icon column and larger symbols.
            .labelStyle(.titleAndIcon)
            .imageScale(.medium)
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 0)
        .scrollContentBackground(.hidden)
        .contentMargins(.bottom, 24, for: .scrollContent)
        .background { ReadingFollower(store: store, reading: reading, proxy: proxy) }
        .onScrollPhaseChange { _, phase in
            if phase == .interacting { reading.following = false }
        }
        .onScrollGeometryChange(for: Bool.self) {
            $0.contentOffset.y + $0.contentInsets.top > 90
        } action: { _, past in
            titleInBar = past
        }
        .safeAreaInset(edge: .bottom) { dock(conversation) }
        .onAppear { openAtInstant(proxy) }
        // A speaker chip opens the pills under a passage that may be far down.
        .onChange(of: store.naming?.start) { _, start in
            if let start { withMotion(Motion.follow) { proxy.scrollTo(start, anchor: .center) } }
        }
    }

    /// The floating player, with "Follow" above it once the owner has scrolled away from the spoken passage.
    private func dock(_ conversation: CachedConversation) -> some View {
        let showsFollow = !reading.following && playback.item?.id == conversation.id
        return GlassEffectContainer(spacing: 10) {
            VStack(spacing: 10) {
                if showsFollow {
                    // Its glass buds off the player's and melts back into it.
                    Button {
                        reading.following = true
                    } label: {
                        Label("Follow", systemImage: "text.line.first.and.arrowtriangle.forward")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .contentShape(.capsule)
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .glassEffectID("follow", in: dockGlass)
                    .accessibilityIdentifier("conversation.follow")
                    .accessibilityHint("Scrolls back to the passage being spoken and keeps it in view")
                }
                ReaderPlayer(id: conversation.id, range: conversation.range) {
                    instant, play in
                    if play { reading.following = true }
                    store.play(playback, at: instant, autoplay: play)
                }
                .glassEffectID("player", in: dockGlass)
            }
        }
        .motion(Motion.rise, value: showsFollow)
        // The player floats over the transcript: larger, it would cover most of the page. Its controls are icons with
        // spoken names, and the times are read as words.
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            Text(shownTitle ?? "")
                .font(.headline)
                .lineLimit(1)
                .opacity(titleInBar ? 1 : 0)
                .motion(Motion.standard, value: titleInBar)
                .accessibilityHidden(!titleInBar)
        }
        if !store.lines.isEmpty {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    UIPasteboard.general.string = store.plainText()
                    copied = true
                    AccessibilityNotification.Announcement("Transcript copied").post()
                } label: {
                    Label(copied ? "Copied" : "Copy transcript", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .labelStyle(.titleAndIcon)
                        .contentTransition(.symbolEffect(.replace))
                }
                .accessibilityIdentifier("conversation.copy")
                .accessibilityHint("Copies the whole transcript with speaker names and times")
            }
            // The one action used often: it stays in the bar when space is tight.
            .visibilityPriority(.high)
        }
        if let conversation = store.conversation {
            // Always in the bar's own overflow menu, rather than a menu nested inside it.
            ToolbarOverflowMenu {
                Button("Rename…", systemImage: "pencil") {
                    draftTitle = store.title == conversation.title ? "" : store.title ?? ""
                    renaming = true
                }
            }
        }
    }

    private var shownTitle: String? {
        store.conversation.map { store.title ?? ConversationRow.untitledName(start: $0.startAt) }
    }

    /// Opening at an instant (a search match): set the player to it, paused, whatever was playing, and scroll the text there, once. The passage there lights up.
    private func openAtInstant(_ proxy: ScrollViewProxy) {
        guard let at, !openedAt else { return }
        openedAt = true
        playback.pause()
        store.play(playback, at: at, autoplay: false)
        if let line = store.lines.last(where: { $0.start <= at }) ?? store.lines.first {
            proxy.scrollTo(line.start, anchor: UnitPoint(x: 0.5, y: 0.3))
        }
    }
}
