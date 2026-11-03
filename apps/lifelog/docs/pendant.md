# Pendant

How lifelog talks to the Limitless Pendant. Built from public sources (Omi, pendant-cli, Limitless help), then
checked against the owner's unit; details and citations are in `docs/research/pendant.md`.

**Status key:** ✅ confirmed by two public sources or official help · 🟢 verified on the owner's Pendant ·
⚠️ unverified (sources disagree or nobody has checked) · 🔬 needs our hardware.

## Protocol in brief

- ✅ One BLE service with a control characteristic (phone → Pendant, write with response) and a data
  characteristic (Pendant → phone, notify). Battery comes from the standard battery service. It notifies only when
  the level changes, so a paused Pendant can go quiet for an hour: the app re-reads it every sync cycle and every
  on-screen status ask. If the service never answers, the level comes from `BatteryStatus.soc` in status replies
  (⚠️ read as a 0–100 percentage, unverified). An old level shows with its time, never as "Unknown".
- ✅ Every write and notification is one protobuf fragment `{index, seq, count, payload}`; we reassemble by
  index, in sequence order, with bounded buffers.
- ✅ Commands we send: set time, status, device info, download mode on/off, ACK. ⚠️ Start/stop recording, LED
  brightness.
  Factory reset, clear storage, unpair and the encryption key command can't even be expressed in our code.
- ✅ Flash pages arrive in download mode, each with a device-wide index, a storage session and a Pendant clock
  timestamp. Audio is Opus, 20 ms per packet, 16 kHz mono. We keep every packet, including 1-byte silence packets.
  See "Pages and time" below for what each field means on real hardware.
- ✅ **ACK deletes every page at or below an index.** We ACK only the unbroken run of pages that are on disk (or
  recorded as gaps), and only the part of that run the same drain itself stored, verified or gapped, so old
  receipts can never vouch for a page. Observe mode, kept for tests, never ACKs; it skips a download
  only when this connection already verified every page the Pendant holds.
- **Flash lives.** Before its first drain on each connection the app asks `GetDeviceInfo` and keys receipts by
  the Pendant's serial plus `storage_instance` and `factory_reset_id`. When those change, or a page comes back at
  a stored index with another device time, a new flash life starts: its pages get their own range of store
  indices, so receipts from an earlier life (before a clear, a reset, or on another Pendant) never match them.
  ⚠️ Unverified: whether `storage_instance` changes when storage is cleared, whether `factory_reset_id` changes on
  a factory reset, and whether the reply carries a serial at all. `storage_run` is not used: it may count reboots.
  If `GetDeviceInfo` gets no answer, the current life is kept and only a re-used index starts a new one.
- ⚠️ The page error codes (1 and 2) mean "read failed" and "corrupt" in one source and the reverse in the other.
  Either way the Pendant itself says the audio is gone: the page becomes a visible gap with the raw bytes kept as
  evidence, and sync moves on.
- A replayed page that differs from the stored one holds the ACK at its index until the owner keeps the stored
  copy or the replay (the other stays as evidence). A replay that matches a receipt whose stored bytes rotted
  repairs them.
- **Held pages.** A page that is encrypted, that the app can't decode, or that has no timestamp holds the ACK at
  its index, so the Pendant keeps it. A decoder bug or a new firmware format then stalls the ACK instead of
  deleting audio. The owner can let a run of held pages go as gaps with one card (their bytes kept). If an
  undecodable page later arrives readable, from a newer app or a clean re-send, it's stored and its incident
  closes by itself.

## Pages and time 🟢

Verified on the owner's Pendant, from one drain of 254 pages (about 8 hours, 4 minutes of audio).

- **The page timestamp is when the page opened**, not when it was sealed. Every chunk's `time_offset_ms` counts up
  from it: 0 to the page's length, the first one sometimes -1 or -2. The next page opens where the last chunk of
  the previous one is, within 4 ms, so pages tile time.
- **One Opus packet per audio chunk, at its own offset.** Offsets step 17 and 23 ms in turn, 20 ms on average, with
  no drift over minutes. A packet plays at page time plus its offset. A recording's first page often starts its
  audio a second in, after the lifecycle chunks.
- **No DTX.** All 11,813 packets are 35 to 55 bytes with TOC `0xb8` (CELT wideband, 20 ms, one frame). Silence is not
  sent as short packets: the Pendant stops recording instead.
- **Storage sessions alternate recording and not recording**, often every few seconds, with no button press: the
  firmware starts and stops recording by itself. A recording session opens with `did_start_storage_session`,
  `did_start_recording` and a recording status of 1, and ends with `did_stop_recording` and
  `did_stop_storage_session`. A not-recording session holds only status chunks (battery, CPU, runtime, BLE, logs,
  every 30 s), so one page can span six minutes with no audio. Sessions are metadata: they never split a
  conversation. The single packet a not-recording page sometimes ends with is the first packet of the next
  recording.
- **`run` counts boots** and `boot_uptime_ms` restarts with it. **Within one boot the RTC is the uptime plus an
  offset** that only a clock set changes: constant to the millisecond over 8 hours.
- **After a reboot the clock is wrong until the next set.** The first page has the RTC unset (equal to the uptime,
  893 ms). About 10 s later the RTC is restored, but 32 s behind: the next recordings claimed times before the last
  recording before the reboot, which is the "overlap across sessions" we saw. Our next set moved it forward 32.3 s in
  the middle of a recording. The timeline places such pages by uptime from the first page our set stamped in the
  same boot (docs/timeline.md).
- **`newest_flash_page` includes the page being written**, so the page after it, the first one a sync governs, is
  the first page stamped by the set.
- `seq` (field 4) equals the flash page index. `ingest_type` was 2 on every page. A long press is stored on flash
  as a button chunk (event 2); no page error was seen.

## Sound activity

The Pendant screen says, under "Recording.", whether the Pendant is storing sound now: "Hearing sound · just now",
"Quiet · listening", or "Last heard 14:02" once the evidence is older than 15 s. Under "Paused." it says "Microphones
off". The phone never decides it hears anything: only the Pendant's own evidence counts.

- 🟢 The firmware runs a sound detector and stores audio only while it fires, opening a storage session about 120 ms
  before the sound (pre-roll) and closing it about 5 s after (`vad_threshold_ms: 5000`). During those pauses the
  microphones keep listening. A real pause (app or long press) stops them. See `docs/research/pendant-vad.md`.
- 🟢 While audio is stored a page opens about every 1.5 s; a quiet session can hold one page for minutes.
- **Strongest evidence: page content.** A `did_start_storage_session` marker or audio packets mean hearing; a
  `did_stop_storage_session` marker means quiet. Only events within 30 s of now by the Pendant's clock count, so the
  pages observe mode re-sends on every download never read as live sound.
- **Fallback: the newest page index between status replies.** No new page for 4 s or more means nothing was stored
  (quiet). Two or more new pages, or a new session, means sound (inferred). One new page in the same session could be a
  quiet page filling up, so the last word stands. Replies more than 20 s apart say nothing.
- While the screen is open the app asks for a status every 5 s, never faster. Pages arrive as they seal on the
  download stream every drain leaves open (see "Background sync").
- `RecordingStatus.vad_level` is decoded when present but has never been seen, so nothing uses it yet.

### Recording on is not the detector

"Recording." and "Paused." mean the owner's and the firmware's choice. The sound line is the detector. They are two
separate values in the app (`RecordingState` and `SoundActivity`), and a silence never becomes a pause.

- 🟢 The firmware's recording state flips with the detector: every detector pause writes a `NOT_RECORDING` chunk
  and logs "Recording state set to NOT_RECORDING". A real pause also switches to idle mode: "Switching to idle mode
  after event BUTTON_LONG_PRESS", then "Device mode set to IDLE_MODE", with the clock slowed to 64 MHz. The app's
  StopRecording runs as the same simulated long press. Waking logs "Waking up from idle mode".
- 🟢 Neither the `did_stop_recording` and storage-session markers nor `recording_source` (0 everywhere) tell the two
  apart. The idle-mode log lines do. `DeviceStatus` has no mode field.
- So a live `NOT_RECORDING` counts as a pause only when lifelog asked for it, a long press was just seen, or the
  newest flash evidence says idle mode. Otherwise recording stays on. RECORDING and LISTENING both mean on. At a new
  connection a `NOT_RECORDING` shows "Checking…" until the drain has read the flash. With no mode evidence on flash,
  the mode from before the disconnect stands: a long press out of reach logs its idle switch on flash. With none
  either (the first connection after launch), it stays "Checking…" until the detector fires. While it says "Checking…" the switch still offers Record: the command goes out at once, even
  during a long catch-up, and only a RECORDING or LISTENING reply confirms it. ⚠️ Unverified: what StartRecording does
  when recording is already on and the detector is only quiet. If no reply confirms it, the app says so.
- ⚠️ Unverified: what the live status says during a detector pause. The Pendant pushes a status right after each state
  change. During one 8.6 s detector pause the app stayed connected and recorded no pause, which suggests that push
  was RECORDING, LISTENING or carried no state. The rule above is safe either way.
- ⚠️ Since the app ACKs, a Pendant that has been silent since its last ACKed page leaves no mode evidence on flash. It then
  keeps the mode it had before the disconnect. A firmware stop outside idle mode (for example, flash full) reads as
  quiet. Flash full has its own warning.
- 🔬 Owner test: with the screen open, stay silent for 30 s, then long-press. Read the live `recording_status` in both
  states from a raw capture. The app keeps only its reading of it.

## Background sync

The app stays connected in the background (`bluetooth-central`, state restoration). The central is created at
launch, before the store opens, as Apple asks. iOS suspends the app between Bluetooth events, so no timer runs
there: sync follows the Pendant's own events.

- **The stream stays open.** After the first drain of a connection, download mode stays on (`{1,0}`); the app never
  sends `{0,0}` while it can save pages. Turning it off and on again would restart the stream from the oldest unacked
  page, which in observe mode is everything again.
- ⚠️ **Pushed pages.** If the firmware keeps sending each page as it seals after the backlog, each notification wakes
  the app and the page is saved at once, with no write from the phone. Unverified on hardware.
- **Pendant events.** Every status the Pendant pushes (it sends one after each state change, such as its detector
  starting or stopping), every status reply, a live storage-session marker and every reconnect or restoration check
  for pages the stream did not bring. If there are any, one drain fetches them. Requests coalesce: a drain under way
  absorbs them and takes one more look when it ends. The page being written is not counted; it comes once sealed.
  Nor is the one just before it: a status can arrive before the page the Pendant just sealed. Once that page is
  saved, the phone counts that status's backlog again, so heard-through follows each status without another one.
  So audio follows each detector stretch either way.
- **Foreground fallback.** While the app is in the foreground it runs a cycle every 5 minutes, in case an event was
  missed.
- **Processing follows.** After a background wake saved audio, a processing pass runs in the same wake under a
  background task (about 30 s), and a `BGProcessingTask` is requested in case that isn't enough
  (`docs/processing.md`).
- **Stall watchdog.** A connection that handles no Pendant message for 6 minutes (the same silence makes its
  telemetry stale) is dropped: that frees a write the transport never answered, and a run loop parked elsewhere reconnects
  when it returns. Nothing is ACKed meanwhile, so the Pendant keeps every page. The app logs `capture.stalled`: how long it was silent, the event its run loop was
  parked in (`idle`: the transport delivered nothing) and the writes still waiting. The Pendant speaks at least every
  ~2.2 minutes, battery included, paused or not. The run loop has stayed parked for hours with the link up, the Pendant
  streaming and iOS waking the app (`docs/decisions.md`, "Watchdogs are stopgaps").
- **Freeze watch.** The whole capture has frozen for hours: the link stayed up on both sides, the
  Pendant streamed and iOS kept waking the app, but no task ran in it, the stall watchdog included. The coordinator
  now stamps a beat every 30 s from its own actor, and a plain GCD timer crashes the app once that beat has not moved
  for 2 minutes of the app actually running (time suspended never counts, so a quiet Pendant or a sleeping phone never
  trips it). iOS relaunches a crashed Bluetooth app with its link, and the crash report shows where every thread was
  stuck. Nothing is lost: only durable pages are ACKed (`FreezeWatch`).
- **Wake log.** The app keeps counts of background wakes: when, how long, pages pushed or pulled, duplicates and
  bytes. No audio or content. It shows in Diagnostics (debug builds) and is in the app container at
  `Library/Application Support/lifelog/background-wakes.json`, for example
  `xcrun devicectl device copy from --device <id> --domain-type appDataContainer --domain-identifier
  com.ericedouard.lifelog --source "Library/Application Support/lifelog/background-wakes.json" --destination .`
- 🔬 To verify on hardware: pushed pages after the backlog (the log shows "pushed"), wakes per detector stretch,
  battery cost of the open stream, and that recording continues while it is open.

### Wake it from Shortcuts

"Sync lifelog" is a Shortcuts action that runs inside lifelog without opening it. It wakes the app, even after a
force-quit, waits up to 10 s for the Pendant, then starts the same run a Bluetooth sync does (drain, upload, pull) and
answers when it ends: "Synced", "Pendant out of reach" or "No network". It logs
`intent.sync` (`bun run events intent`). Nothing in it ACKs: the drain does, as always.

How to set it up, once, on the iPhone:

1. Shortcuts, Automation tab, New Automation (+).
2. Pick a trigger: **App** with "Is Closed" and a few apps you use often (Messages, Safari...); **Wi-Fi**, "Joins"
   your home or office network; **Charger**, "Is Connected"; **Time of Day**, repeat daily, then make one per hour
   you want.
3. Next, Add Action, search "Sync lifelog" (under lifelog).
4. Choose **Run Immediately**, not "Run After Confirmation", and turn off "Notify When Run" if it nags. Done.

- ⚠️ Unverified on hardware: that the action launches a force-quit lifelog in the background. Apple documents that an
  intent runs in the app's own process, in the background if it asks (`supportedModes`), but not the force-quit case.
  To test: force-quit lifelog, run the action from Shortcuts, then `bun run events --since 5m intent` shows
  `intent.sync`.

## Firmware limits

- ✅ One bond at a time. If another phone or app holds it, our commands are silently ignored: the app shows
  "busy elsewhere" and lets go of the link instead of fighting for it.
- ✅ After a reboot, recording can't restart until the clock is synced. We sync on every connection and cycle.
- ✅ When flash is full, recording stops until the phone has fully caught up.
- ⚠️ Pages come oldest first and only from the oldest unacked page, so in observe mode (tests only) each drain
  re-sends pages we already have. They dedupe, but transfers are longer.

## Button and lights (official help)

| Gesture | Effect |
| --- | --- |
| Quick press | Quick question to AI: the last minute, transcribed by the server (ElevenLabs), to Claude or ChatGPT. With the Copilot on, "tell me now" (below). While paused, it only resumes (below) |
| Hold ~2 s | Recording on/off. The Pendant does this itself; the app only reflects it, never reverses it |
| Hold until red, release | Recovery mode; hold again until off to leave |
| Hold until red, release, hold until off, then press | 🟢 Restart: keeps every page; red ×3 until the phone sets the clock. A Pendant that stopped advertising after a link timeout came back at once. The "Pendant not answering" notice gives these steps |
| Press, then press-and-hold through purple | **Factory reset: deletes unsynced audio.** Never a recovery step |

| Light | Meaning |
| --- | --- |
| White | Recording (alternating with orange/green while charging/full) |
| Orange / green | Charging / full |
| Blue | Ready to pair |
| Purple | Factory reset in progress |
| Red ×3, repeated | Clock needs a sync before recording can restart; reconnecting fixes it |
| Red ×10, repeated | Storage full; sync fully |
| Red ×4 every 5 s | Temperature out of range |
| Breathing red | Microphone failed to start; restart |
| Very fast red | Device init error; recovery mode, then exit |

🟢 A paused Pendant still reports a quick press at once (the press reached the phone before the
Pendant woke). It is also stored on flash. So a press while paused resumes recording through the normal resume:
the Pendant must confirm it, and nothing else happens. Only a fresh press counts, one whose counter rose on this
connection or whose time is within 10 s of now, so a press replayed at connect never turns recording on or asks
anything.

Each live short press is one quick question (`QuickPress`); the same press replayed is dropped. The firmware's
`double` event (raw 3) does nothing; the double press has no action. Every live press is a `press`
event: `bun run events --since 30m press`.

While the Copilot is on (Settings), a press goes to it instead (`Copilot`): the line being said is finished
(Scribe commits it, at most 1.5 s), then the copilot is asked to speak now (`POST /now`), and its answer is spoken
into the AirPods. A press while it speaks stops it. Each press logs `copilot.press`, each answer `copilot.said` with
`sincePressMs`.

What the phone and the copilot say to each other (the copilot's address in Settings, over Tailscale):

| Call | Carries |
|---|---|
| `POST /scribe` | → `{url}`: a Scribe Realtime socket with a single-use token and the copilot's options |
| Scribe socket | 0.5 s chunks of 16 kHz PCM, base64; pages older than 20 s are skipped |
| `POST /caption` | each finished line: `{speaker: "Room", text, source: "pendant"}` |
| `POST /now` | a press: "tell me now" |
| `WS /ws` | `{type: "say", text, audio}`: the answer as MP3, played in the AirPods; other types are ignored |

What a press does otherwise (`ButtonActions`, decisions in `docs/decisions.md`):
- The press is placed at the Pendant's own time of it (`PressClock.pressedAt`), not when it arrived: a
  press has reached the suspended app 11 s late, in one burst with 11 held-back pages, when a silent push woke it.
- It waits until the newest stored audio reaches the press, at most 4 s, then renders the window (60 s before the
  press) as Ogg Opus, as fragments are (`RecentAudio`): only the newest pages and the clock
  syncs from them on, never the whole archive's. The server transcribes it at once with ElevenLabs
  (`POST /quick-transcriptions`, under half a cent a minute, counted in the spending).
- In the app, a card rises over whatever screen or sheet is open (`PressOverlay`, its own window) and shows each stage
  as it happens: heard, listening back, transcribing, then the words with "Ask Claude" and "Ask ChatGPT". A failure says why, with Try again. The Pendant
  screen's lens lights up and its ring follows the same stages. A tap outside or a swipe down puts the card away; the
  outcome of a press still at work shows again.
- In the background, the outcome is a notification instead: the words (a tap opens them in lifelog, its Claude and
  ChatGPT actions open the app), or why it failed. Claude and ChatGPT open with the words filled in
  (`https://claude.ai/new?q=`, `https://chatgpt.com/?q=`, universal links only), or, over about 6 KB, copied with the
  app opened empty.
- Each press ends with a `press.done` event: its outcome, `reason` when it failed, and each stage's
  milliseconds since the press: `receivedMs`, `settledMs`, `renderedMs`, `transcribedMs` (upload and transcription;
  the server's `quick_transcription` event has its own `ms`) and `doneMs`. In Debug, Diagnostics' "Press once in 3 s"
  presses the simulated Pendant, with fixed words, so each stage shows in the simulator.
- Each finished press is kept in the Presses tab (`presses.json` in Caches, the newest 200, never synced): its words
  and outcome, one card per press, which asks Claude or ChatGPT.

⚠️ LED brightness: the command exists and Omi sends it, but no source shows it working, whether 0 turns the
recording light off, or whether it survives a reboot. It takes a level from 0 to 100. Settings offers Off (0) and four
steps (10, 35, 65 and 100) while connected, and the first change asks the owner whether the light changed; the answer
is kept on the phone.

## Omi

lifelog can drain an Omi pendant (firmware 3.0.20 or later) instead of a Limitless Pendant. How it works and what is
left out is in `docs/research/omi.md`; anyone working on it reads that file's first section first.

- The app connects only to drain, about every 5 minutes while it is open and whenever it comes forward or the "Sync
  lifelog" shortcut runs, then lets go: an Omi drops its audio while a phone is connected.
- ⚠️ **Released Omi firmware (3.0.21) deletes audio from the Omi as soon as the phone receives it**, before lifelog
  has saved it. If the phone dies or the app is killed mid-transfer, that audio is lost. The owner accepted the risk;
  the Pendant screen says so to an Omi user, and tells them to update once an Omi firmware fixes it.
- 🔬 Not tried on a real Omi yet: the GATT setup, the clock write, INFO while the SD card remounts, and read speed.

## Hardware tests still owed 🔬

1. Golden captures from our unit: a status reply, a real audio page, a button event, a page error.
2. Start/stop recording by command: does the status reply confirm it, and does it echo our request id?
3. LED brightness: applied? 0 = off? persists? Do error colours ignore it?
4. Does the firmware act on and answer a control command while a download streams? (The app writes it at once
   and never stops the download for it: switching download mode off and on would restart the stream from the oldest
   unacked page.) Does recording continue while a download runs? Do page indices restart after a clear? (A reboot keeps them
   and adds one to `run`.) What does `GetDeviceInfo` return, and which of `storage_instance`, `storage_run` and
   `factory_reset_id` change after a reboot, a clear and a factory reset?
5. Which page error value means what; can a re-read succeed?
6. Background: lock, force-quit, reboot and Bluetooth toggles each bring the drain back.
7. One ACK window approved by the owner: the Pendant frees exactly the pages we ACK and re-sends the rest.
8. Clock: drift over a day disconnected, and whether any message gives the Pendant's current time before a set.
   Is a press's timestamp the press or the release?
