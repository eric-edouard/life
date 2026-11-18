# Design

How the app looks and what each screen shows first. The app keeps its logic in feature stores; the views sit on
top of them.

## Visual system

Life's brand (`docs/brand.md`, `assets/brand/tokens.css`): dark and light as the system says, Palette's thirteen
colours (`bg`, `fg`, `card`, `tile`, `sheet`, `paper`, `muted`, `faint`, `line`, `flag`, `ai`, `ok`, `on`), where colour
always means something. Native Liquid Glass for bars, sheets and floating controls. The type is Manrope in the brand;
the phone still draws SF, Newsreader and Geist Mono until its screens are redone. State is never shown by color alone.

## Navigation

One tab, **Pendant**: a minimal shell until the new screens replace it. The Library, People, Presses, conversation
reader, export and spending screens are gone (the cuts and the look, 18 Nov 2026); Backup & restore stays, in Settings. No
Settings tab: the few settings live on the Pendant screen.

## Screens

- **Pendant** (replaces Now). The first thing on open: am I recording? A large, beautiful record control with a
  live red dot that reflects the Pendant's real, confirmed state (pending, stale and unknown are shown as such).
  Battery, storage, sync and other facts at a glance. Settings kept short and sensible. Owner picked **C**:
  a large status sentence ("Recording." with the live dot, "Paused.", "Not connected.") with its evidence line, a
  full-width capsule switch that only slides once the Pendant confirms, and glass tiles that expand into detail;
  settings inline at the bottom.

## Information hierarchy

What the owner needs first on each screen, from the server's data (the feed, the outbox, the uploader). The old
pipeline's parts, approvals, passes and per-part states are gone from every screen.

- **Pendant.** 1. Am I recording: the lens, its sentence and evidence, Pause. 2. What needs me:
  capture conditions and incidents, then processing only where the owner can act: the Mac away, a switch off, credits out, not paired. Offline and uploads belong
  to the status, not a card. 3. Today: saved, spent, battery, storage, audio still on the Pendant.
- **Status sheet.** 1. The one state, with its sentence. 2. What waits and why: audio to upload (its length), uploads
  failing (how many, and the last reason), edits to send, and conversations by the feed's reason, each a sentence with its glyph. 3. Edits the server refused, each with
  OK.
  4. Last sync and network.
- **Settings.** 1. Processing: transcription, AI, the vocabulary. 2. Alerts, the Lock Screen, the light.
  3. Your data: location, backup, the server it is paired with. The archive's move to the server shows only while
  it runs, just after, or after it failed.

## Beyond the app

Action-button shortcut for "am I recording?", a small home-screen widget, Lock Screen accessories, a Control Center
toggle, and notifications when recording or the connection changes on the Pendant itself (not for changes made in
the app). Low-battery alerts are configurable.

The Pendant widget always shows the last battery level it has. Current only from a connected Pendant within one
sync cycle; otherwise `~73` (Lock Screen) or grey (Home Screen), because a paused, off or out-of-reach Pendant all
look the same to the phone: the link drops and says nothing about why.

## Feel

The default iOS way, done with care: deliberate transitions and small delightful animations, with Reduce Motion,
Dynamic Type, VoiceOver and Increase Contrast fully supported, and no cost to performance. Nothing on the Pendant
screen moves while it scrolls (`stillWhileScrolling()`): any animation there redraws the whole screen every frame. The
lens draws off the main thread.
