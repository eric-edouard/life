# Dictation PR 4b: the field (brief)

Stacked on **4a** (`dictation-4a`: capture and the #802 drop) and **4t** (`dictation-4t`: `POST /dictation/transcript`). Branch from 4a and merge 4t in, or rebase once they land. Phone only (app target plus a small Kit client).

## What exists (do not rebuild)
- `Lifelog/Dictation/DictationCapture.swift` (4a): `DictationCapture.begin(library:sync:ended:) async throws -> DictationCapture`, then `finish() async throws -> Data` (Ogg Opus, idempotent).
  - `begin` asks for the microphone (throws `.denied`), stores the quiet stretch **before** opening it (throws `.noLibrary` or the write's error; the mic stays closed), and takes the app's audio session lease.
  - `ended` fires when it stops on its own: the 10-minute cap, an interruption, the route lost, or playback taking the session. The field then calls `finish()`.
  - `finish()` shrinks the stretch and posts it through the outbox. Library and sync come from the environment (`\.library`, `SyncStore`).
- Kit: `MicCapture.recording.level` (0 to 1, the last buffer's RMS) for the listening stream; `AudioSessionOwner.shared`.
- Server (4t): `POST /dictation/transcript`, device token, body `audio/ogg`, answer `{text}` 200.
  - 503 `identity_busy`: nothing billed, try again. 502 `transcription_failed`: Thai words missing. 400: bad audio.
  - No retention, no replay: a lost answer is "Not written. Please say it again." Never resend the same bytes after an answer may have been lost.
  - The phone needs a ServerAPI call for it, plus `ContractTests` (every path the client calls) and a wire fixture if the decoder is checked (`apps/server/fixtures/wire`, `WRITE_WIRE=1`).

## The microphone (the designer's decision for 4b; spec `~/Life/docs/product/app-design/tell-life-2026-11-21.md`, "The microphone"; close-up board `DuoFoldTellLifeMic`)
- **One control, in one place.** Every dictation field uses it; Tell Life reuses it later.
- **Tap** starts. Tap again pauses, and tap again goes on. **Hold** records while held; letting go pauses, and the words stay.
  - While recording, the mic is an fg disc with a pause glyph and a soft ai (periwinkle) pulse.
  - Hold grows the disc to 64 pt.
- Each recording run (start to pause) is one `DictationCapture`. On pause: `finish()`, POST the bytes, and insert the words at the selection. Going on starts a new capture, so each run has its own quiet stretch and 10-minute cap.
- **One option, `send: (() -> Void)?`.** Without it there is no Send, swipe or track; all of 4b's fields go without it. With it (Tell Life, later): Send sits right of the mic, and while recording it dissolves into a "Swipe up to send" hint on the mic; a swipe up from the mic, or a hold slid up the track, sends. **Build the option's shape now. Don't draw the Send/track look in 4b.**
- Live words while speaking ("arrive as he speaks") need streaming recognition, which 4t does not do: words land at each pause. Say so in the PR.
- Tokens: Life's current ones (`Shared/Palette.swift`, `Metrics`). **No Manrope** for this control. Every change is a spring of about 220 ms; under Reduce Motion, cross-fade and hold the hint still.

## Field states and copy
Frames are on canvas v101 (`DuoFoldDict*`, the `KitDictation` board): Rest, Ask, Listening, Silence, Again, Writing, Filled, Failed, Denied, NoMic, Busy; the one-line Search, the sheet row and the tall draft. The approved copy is in `~/Life/docs/product/app-design/dictation-2026-11-20.md`. Failure copy sits inside the field's top line. Add haptics and VoiceOver.

## Migrate
Move every free-text field onto the one field (`DesignSystem/DictationField.swift`, or extend `Pieces.swift` `Field`):
- `CheckCard.swift` (the answer note);
- `MatterPage.swift`;
- `StartAgentSheet.swift`;
- `Pieces.swift` `Field`;
- **Search** (`Shell/SearchScreen.swift`; keep the system search tab, query and filtering).

Line numbers moved on main (a People tab landed), so `rg -n "TextField|searchable" apps/lifelog/apps/ios/Lifelog`. `scripts/design-system.test.ts` caps only go down.

## Rules
- **Do not edit** (other builders): LifeStore.swift, RootView.swift, NotificationRoute.swift, IncidentNotifier.swift, the MCPClient/MCPError/ActionState/LifeActions/OAuth layer. If Search needs RootView, ask the coordinator.
- Heavy jobs go only through `tools/heavy.sh`. No simulator boots, no device install, no xcodebuild beyond the gate's own. While iterating, run only the changed tests. Push once; the pre-push hook is the gate.
- `env -u GITHUB_TOKEN` for git and gh. Never print the environment. Made-up data only.
- Split at about 800 lines. The PR body has a `## Debt plan` and lists device benchmarks as open: stop-to-editable p50/p95 for local, mixed and Thai speech, idle and saturated; the audio session on a real iPhone (a call, AirPods, playback then capture).
- A screen change gets a design review (`apps/ios/AGENTS.md`) before its debt verdict; the coordinator schedules it.
