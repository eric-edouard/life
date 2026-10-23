import Library
import Observation
import SwiftUI
import Timeline

/// Where playback stands in this conversation's transcript, and whether the page follows it. A small reference
/// model so that a new spoken line redraws only the visible passages, never the list or the page around it.
@Observable
final class ReadAlong {
    /// Start of the line being spoken; `nil` in longer silences or while this conversation isn't loaded.
    private(set) var spoken: CaptureInstant?
    /// Start of the last line that began at or before the playing position.
    private(set) var reached: CaptureInstant?
    /// The word being spoken in the spoken line. Only that passage reads it, so a new word redraws it alone.
    private(set) var word: NSRange?
    /// The page scrolls to keep the spoken line in view. The owner scrolling by hand turns it off; "Follow", or
    /// playing from a passage, turns it back on.
    var following = true

    /// Returns whether the spoken line changed.
    @discardableResult
    func update(_ lines: [CachedTurn], at position: CaptureInstant?) -> Bool {
        guard let position else {
            let changed = spoken != nil
            (spoken, reached, word) = (nil, nil, nil)
            return changed
        }
        let index = lines.line(at: position)
        let line = index.map { lines[$0].start }
        let changed = line != spoken
        spoken = line
        reached = lines.lastStarted(at: position).map { lines[$0].start }
        let lit = index.flatMap {
            lines[$0].words?.spoken(at: lines[$0].start.distance(to: position), in: lines[$0].text)
        }
        if lit != word { word = lit }
        return changed
    }

    func state(of start: CaptureInstant) -> Passage.Phase {
        if start == spoken { return .spoken }
        if let reached, start <= reached { return .past }
        return .upcoming
    }

    /// Plays `store`'s conversation from `instant` (its start when `nil`), and follows it on the page.
    func play(_ store: ConversationStore, from instant: CaptureInstant?, on playback: PlaybackStore) {
        following = true
        store.play(playback, at: instant)
    }
}

/// Keeps `ReadAlong` on the playing position and scrolls the spoken passage into view while following. It is the
/// only view reading the position ten times a second, and it sits outside the list so it never unloads.
struct ReadingFollower: View {
    let store: ConversationStore
    let reading: ReadAlong
    let proxy: ScrollViewProxy

    @Environment(PlaybackStore.self) private var playback

    var body: some View {
        Color.clear
            .onChange(of: position, initial: true) { _, position in
                // Animated, so the highlight glides from the passage just spoken to the next.
                let changed = withMotion(Motion.standard) {
                    reading.update(store.lines, at: position)
                }
                if changed, reading.following { follow() }
            }
            .onChange(of: reading.following) { _, following in
                if following { follow() }
            }
    }

    /// This conversation's playing position. While its audio loads nothing is spoken yet, so no passage lights up.
    private var position: CaptureInstant? {
        playback.item?.id == store.id && playback.status == .ready ? playback.position : nil
    }

    private func follow() {
        guard let target = reading.spoken ?? reading.reached else { return }
        withMotion(Motion.follow) {
            proxy.scrollTo(target, anchor: UnitPoint(x: 0.5, y: 0.3))
        }
    }
}
