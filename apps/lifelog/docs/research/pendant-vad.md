# Does the Pendant gate recording with on-device VAD?

**Verdict: VERIFIED. The Pendant runs voice/sound activity detection on the device and stores audio only while it
fires.** The "recording session" switches are VAD start/stop, not a periodic ping or flush. Evidence from the
owner's Pendant (firmware 1.1.5, one drain, 254 pages), analysed locally on a copy. No audio or transcript
content is reproduced here.

## 1. The firmware says so (its own log chunks)

Flash pages carry `Chunk.log_output` (field 10): plain Zephyr log lines. At boot the firmware prints its settings:

- `pendant_settings: vad_threshold_ms: 5000`, `show_vad_status_led: 0`, `allow_recording_on_usb: 0`, `sync_mode: 1`.

Then there are two different "not recording" states:

| | Idle (user stopped) | VAD pause |
|---|---|---|
| Entered by | long press (`Switching to idle mode after event BUTTON_LONG_PRESS`) or app `StopRecording` (cmd 18) | nothing logged: no button, no command, no USB event |
| Log | `Device mode set to IDLE_MODE`, `Setting HFCLK to 64MHz` | only `Session num:N started`, `Recording state set to NOT_RECORDING` |
| Mics / codec | stopped. A wake logs `Starting audio with omni and PDM mics`, `Reseting opus codec state` | kept running: resumes log neither line, the CPU stays at 128 MHz |
| Left by | long press / app `StartRecording` (cmd 17) | `Recording state set to RECORDING`, again with no trigger logged |

So during a VAD pause the microphones keep listening and only storage stops. The **8 h with no audio** (pages
146–226) was the idle state: it ends with `Waking up from idle mode after event BUTTON_LONG_PRESS`. It was not a VAD
pause.

## 2. The schema has a VAD

These come from pendant-cli's protos, which were reconstructed from the official app:

- `RecordingStatus { recording_state: NOT_RECORDING/RECORDING/LISTENING; recording_source: BUTTON/AMBIENT_SOUND; vad_level }`
- `DeviceStatus.vad_threshold` and the command `SetVADThreshold { uint32 vad_threshold_ms }` (cmd 24).

On flash, the `recording_status` chunks only ever carry `recording_state` (0 or 1). The source and `vad_level` were
absent on all 23 chunks, including the automatic ones. **Correction to pendant-cli:** `audio_data.did_start/stop_recording`
are *not* button-only. They fired on every automatic recording, about 119 ms before `did_start_storage_session`.

## 3. The timing is acoustic, not periodic

There were 8 automatic recordings in boot 5. All of them happened while USB was connected (`Recording while charging`).

- **Recording lengths:** 7.9, 8.8, 10.9, 11.5, 11.8, 54.6 and 72.5 s, plus one of 43.8 s that our app's StopRecording ended.
  The minimum is above the 5 s threshold, which fits a 5 s hang-over.
- **Pauses:** 0.22, 0.76, 4.3, 4.9, 8.4, 10.6, 19.9 and 23.5 s. Start-to-start intervals ran from 9.8 to 81 s. Nothing
  repeats with a fixed period. A pause of 0.2 s is an immediate re-trigger.
- **Start = sound onset with a pre-roll of about 120 ms.** Each automatic recording holds 6–8 packets (120–160 ms)
  stamped *before* `did_start_storage_session`. The last packet of the pause page is one of them. The first packet is
  already loud: −16 to −38 dBFS, against −45 to −57 dBFS in the quiet button-started recordings. Before that packet,
  nothing is stored. Button- or app-started recordings look different: audio starts about 1.03 s after the session
  opens, and the first packets are quiet.
- **The stop is not a plain loudness gate.** The last 5 s before each stop is no quieter than earlier 5 s stretches of
  the same recording (100 ms RMS peaks of −35 to −25 dBFS).
- **Apple SoundAnalysis** labelled 1 s windows. Four recordings end 7, 7, 14 and 28.5 s after the last window labelled
  speech. Three recordings (8–12 s) have no window labelled speech at all, mostly music or unlabelled. So the trigger
  is not speech-specific, at least as Apple's classifier hears this 16 kHz CELT audio. The enum name `AMBIENT_SOUND` fits.

## 4. Public statements

- Limitless help center, [Pendant storage](https://help.limitless.ai/en/articles/10761340-pendant-storage): "the
  pendant only stores audio if a voice is detected". It frames this as storage: 35 h of continuous speech, about 70 h
  of wear at 50 % speech.
- pendant-cli ([cli.py](https://github.com/MAkcanca/pendant-cli/blob/5e0eace94042096a74944861cc4d60060cd3aa8f/src/pendant_client/cli.py#L932)):
  "recording is VAD-gated; talk near it then retry". `decode.py` describes a "4-7 chunk" VAD look-back. We measured
  6–8 chunks.
- The help center says the white LED shows recording. The firmware flag `show_vad_status_led` (0 here) suggests the
  LED can show VAD state, but no public setting for it was found. Neither the ~100 h battery claim
  ([Business Insider](https://www.businessinsider.in/limitless-ai-pendant-clips-clothes-hears-records-everything-2024-4))
  nor any found page ties battery life to VAD. No public setting changes `vad_threshold_ms`. Only the BLE command
  exists.

## 4b. Recording on versus detector idle (same drain)

- Every detector pause writes `recording_status` 0 and logs "Recording state set to NOT_RECORDING". Every start writes 1.
  So the firmware's recording state is the detector's state, not the owner's choice.
- Only a real pause adds the idle-mode lines: "Switching to idle mode after event BUTTON_LONG_PRESS", "Device mode set
  to IDLE_MODE", and HFCLK 64 MHz. Waking logs "Waking up from idle mode" and restarts the mics and codec.
- The app's StopRecording (cmd 18) ran as the same simulated long press, within 1 ms of "Stop recording requested".
- `did_stop_recording`, the storage-session markers and `recording_source` (always 0) look the same for both.
- After each state change the Pendant pushes an unsolicited `DeviceStatus` ("PendantAllMsg tag:5 - req_id:0", within
  50 ms). The app was connected through one 8.6 s detector pause and stored no recording change. The app code of that
  time stored a pause for any unsolicited NOT_RECORDING, so the push most likely carried RECORDING, LISTENING or no
  state. This is inferred, not read.

## 5. Still unknown

- What the detector keys on: speech only, or any sound above a level. Music-labelled audio was kept.
- Whether 5000 ms is the hang-over after the last detection. That fits the lengths, but the stops cannot be lined up
  with any energy feature.
- Behaviour off USB. All of the automatic switching above happened while charging, even though
  `allow_recording_on_usb: 0`.
- Whether `LISTENING` (state 2) is ever reported live during a VAD pause. Flash shows only 0 and 1.

## 6. Five-minute test that settles it

Unplug the Pendant. Long-press to start recording. Note the phone-clock time at each step:

1. 60 s silence in a quiet room
2. 30 s normal speech at about 30 cm
3. 30 s silence
4. 30 s music or TV with no voice
5. 30 s silence
6. 30 s whisper
7. 30 s silence
8. 30 s normal speech from 3–4 m
9. 30 s silence

Then sync and dump the lifecycle chunks, log lines and per-packet energy. Read the result like this:

- **VAD:** the 60 s silence has no audio. Each active segment that triggers opens a session about 120 ms after its
  onset (6–8 pre-roll packets). The session closes about 5 s after the segment ends.
- **Speech-only or any sound:** whether segment 4 triggers.
- **Detection threshold:** whether segments 6 and 8 trigger.
- **Periodic (the alternative):** boundaries fall at fixed intervals regardless of segment, and audio exists during
  the silences.
- Optional: read `DeviceStatus.recording_status` live during a silence to see whether it reports `LISTENING`.

## 7. Five-minute test result (2026-10-09)

Run by the owner, unplugged, firmware 1.1.5. Instrumental music played from the start until about 23:10:40 (not only
in its slot), so the music and the near-speech slots overlap. The owner's spoken notes in the recording explain it.
Loudness is the median per 2 s in dBFS; the quiet room sits at about −48.

| What | Loudness | Stored? |
|---|---|---|
| Quiet music right after waking (23:06:56) | about −50 | no: the session closed after 8 s |
| Music with no voice, louder (23:07:53 on) | −30 to −36 | yes, continuously for 2 min 40 s, with no speech for the first 67 s |
| Normal speech at 30 cm, over the music | −18 to −30 | yes |
| Whisper | −40 to −43 | yes, for the whole whisper |
| Normal speech from 2.5–3 m | −35 to −45 | yes, for the whole segment |
| Single clicks or knocks in the silences | short peaks to −15 | yes: each makes a clip of 4.5–5.5 s |
| Quiet room | −48 to −51 | no |

- **It detects sound, not speech.** Music with no voice holds recording open as long as it plays. The phone's
  speech-only upload policy (Silero) is what keeps music and TV from being transcribed.
- **Whisper and far speech are kept.** Nothing the owner said was lost.
- **Stop delay:** the session closes 4.5–5 s after the sound ends, matching `vad_threshold_ms: 5000`.
- **Short noises** in an otherwise quiet room each cost one ~5 s clip (4 in about 2 minutes here).
