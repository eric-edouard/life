# Design

How the app looks and what each screen shows first. The app keeps its logic in feature stores; the views sit on
top of them.

## Visual system

Dark grayscale with one deep red. Ground `#0B0A0A`; surfaces `#141312`, `#1C1A19`, `#232120`; hairlines
`rgba(236,231,225,.08–.14)`. Text `#ECE7E1`, `#CFC8C0`, `#A9A29B`, `#8A837D`. Red fills `#9B1B24`, red text
`#E2626A`, live dot `#D9363E`. Native Liquid Glass for bars, sheets and floating controls. SF for UI, Newsreader for
conversation titles and quotes, Geist Mono (tabular) for times and durations. State is never shown by color alone.

## Navigation

Three tabs: **Pendant**, **Library** (its search in the toolbar) and **Presses**. No Settings tab: the few settings
live on the Pendant screen.

## Screens

- **Pendant** (replaces Now). The first thing on open: am I recording? A large, beautiful record control with a
  live red dot that reflects the Pendant's real, confirmed state (pending, stale and unknown are shown as such).
  Battery, storage, sync and other facts at a glance. Settings kept short and sensible. Owner picked **C**:
  a large status sentence ("Recording." with the live dot, "Paused.", "Not connected.") with its evidence line, a
  full-width capsule switch that only slides once the Pendant confirms, and glass tiles that expand into detail;
  settings inline at the bottom.
- **Library**: Find A, the journal. Day sections, conversation rows with title, one-line summary, people, place,
  duration and processing state; search in the toolbar; multi-select to export or merge. The People button carries the
  number of voices to name. Wordless recordings and dictation fold into one quiet line a day.
- **People**: "Who's this?" on top while voices wait for a name, then the owner's people. "Who's this?" is one voice
  at a time, in the server's order: a large question, when and how much they talked with the owner, why it asks, the
  clips as Newsreader quotes that play one after another, the answer, then the next voice slides
  in. Each clip's words light up as they are spoken. "Several people" puts the people under each clip, to name it in
  place. A typed name goes as typed; the server finds the person, other names included. It ends on "All caught up".
- **Presses**: the Pendant's button presses on this phone, by day, newest first, each a card like the press overlay's:
  its lens, kind, time and window, the words in Newsreader, delivered or why it failed, and glass actions: Ask Claude
  and Ask ChatGPT for a single, "Send again" for a double, and play. Kept in Caches, never synced, safe to lose.
- **Conversation**: A, the reader. The transcript is the page; the spoken passage is raised and followed, and its
  word being spoken is white on red, like live captions; a speaker's name opens the pills under it;
  tap a line to play from it; a floating glass mini player.

## Information hierarchy

What the owner needs first on each screen, from the server's data (the feed, the outbox, the uploader). The old
pipeline's parts, approvals, passes and per-part states are gone from every screen.

- **Library.** 1. The day, then its conversations, newest first: title (or "Conversation at 13:52"), one line (the
  summary, else what is still coming, else the first words), time, length and place. 2. People. 3. While a conversation isn't done, one plain sentence of where it stands: Not
  uploaded yet, Uploaded, Transcribing, or why its summary waits. A "Waiting to sync" mark while an edit of it
  sits in the outbox. 4. Wordless recordings and dictation to the Mac fold into one quiet line a day, "3 quiet
  recordings · 2m", that opens in place. In the bar: the status, the date jump, People with the voices to name.
- **Conversation.** 1. Title, when, where (opens Maps), who spoke. 2. The summary on one line, or the one sentence
  why it waits. 3. The transcript, with a card above it while words are on their way, chapter titles, "Split by AI",
  "Split by you" or "Merged by you" with Undo, and "Split here?" between the two passages where the summary run was
  unsure. 4. The floating player.
- **Pendant.** 1. Am I recording: the lens, its sentence and evidence, Pause and the scissors. 2. What needs me:
  capture conditions and incidents, then processing only where the owner can act: the Mac away, a switch off, credits out, not paired. Offline and uploads belong
  to the status, not a card. 3. Today: saved, spent, battery, storage, audio still on the Pendant.
- **Status sheet.** 1. The one state, with its sentence. 2. What waits and why: audio to upload (its length), uploads
  failing (how many, and the last reason), edits to send, and conversations by the feed's reason, each a sentence with its glyph. 3. Edits the server refused, each with
  OK.
  4. Last sync and network.
- **People and "Who's this?".** 1. "Who's this?" while voices wait: how many, the first one's words. 2. The owner's
  people, with rename (the other names edited with the name) and merge. Every queued voice plays the clip the server
  cut.
- **Settings.** 1. Processing: transcription, AI, the model, the vocabulary. 2. Alerts, the Lock Screen, the light.
  3. Spending and your data: location, backup, the server it is paired with. The archive's move to the server shows only while
  it runs, just after, or after it failed.

## Beyond the app

Action-button shortcut for "am I recording?", a small home-screen widget, Lock Screen accessories, a Control Center
toggle, and notifications when recording or the connection changes on the Pendant itself (not for changes made in
the app). Low-battery alerts are configurable.

The Pendant widget always shows the last battery level it has. Current only from a connected Pendant within one
sync cycle; otherwise `~73` (Lock Screen) or grey (Home Screen), because a paused, off or out-of-reach Pendant all
look the same to the phone: the link drops and says nothing about why.

Two circular Lock Screen widgets show ChatGPT (Codex) and Claude Code subscription usage. Empty means unused; full
means the selected quota is exhausted. The center shows the time until reset, such as `5D` or `1H 20M`. Each widget
defaults to the weekly quota; edit it to select the five-hour quota. These are the provider's account-wide limits,
not Life's token spending. The ChatGPT dial is explicitly Codex's quota, not a measure of every ChatGPT feature.

A dial updates when the app pulls the feed, so when it is woken, usually by the Pendant. Minute timeline entries update the countdown. A reading older than an hour is dimmed and marked `?`; VoiceOver names
its observation time. Missing usage shows `—` in a dashed ring. After a reset, a dashed ring with `↻` means waiting
for new usage, never an assumed zero.
Provider credentials stay on the Mac. Claude requires the status-line bridge in `apps/dictation/README.md`.

## Feel

The default iOS way, done with care: deliberate transitions and small delightful animations, with Reduce Motion,
Dynamic Type, VoiceOver and Increase Contrast fully supported, and no cost to performance. Nothing on the Pendant
screen moves while it scrolls (`stillWhileScrolling()`): any animation there redraws the whole screen every frame. The
lens draws off the main thread.
