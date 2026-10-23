import Foundation
import ServerAPI

/// Everything the Lens layout draws, as plain values read at one tick of the screen's timeline. The layout reads no
/// store: `PendantScreen` builds this and hands its attention cards in beside it.
struct PendantLayoutInput {
    let capture: CaptureFacts
    let transcription: TranscriptionFacts
    /// Is it recording, in words, with what its button does.
    let hero: HeroReading
    /// Battery, storage, saved today, backlog: each already classified current, last known or unknown.
    let glance: GlanceFacts
    let actions: PendantActions
    /// Ends the conversation now. The frame confirms it with its toast and haptic, so the layout calls this, never
    /// `actions.split`.
    let split: () -> Void
    /// The tick this input was read at.
    let now: Date
}
