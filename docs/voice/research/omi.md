# Omi

Can an Omi pendant feed Life's page pipeline? A read-only spike, 22 Oct 2026, against Omi's open-source repository
(BasedHardware/omi, `main` at 29797760, MIT). The same day the app gained Omi support on the owner's decision below;
"What the app does" says how.

## Before any work on the Omi

Read the latest Omi firmware release notes first (GitHub releases of BasedHardware/omi, tags `Omi_CV1_v*`) and the
state of BasedHardware/omi#20450 ("ring custody"). On 22 Oct 2026 the latest release was 3.0.21 (5 Aug, "fix audio sync
issue"), and #20450 was still an open draft (last updated 3 Oct): records are freed on delivery.

Once a release ships custody:

1. Set `OmiFirmware.custodyFixedIn` to its version. The in-app warning then tells the user to update in the Omi app.
2. Tell the owner in your report: the risk below is gone for updated pendants.
3. Check the shipped protocol: the draft has the app opt in (`CUSTODY_ENABLE`, 0x14, with capability bits) and an
   ADVANCE by ring id (0x15). The app sends neither yet.

## Verdict

Yes, with one blocker that is not ours to fix. The Omi records the same audio as the Limitless Pendant (Opus CELT,
16 kHz mono, 20 ms frames), so nothing is transcoded. Its offline ring has numbered records, a read from a number and a
command that frees everything below a number: that maps onto pages, ACK and resend. But the released firmware
(3.0.21) frees records by itself as soon as Bluetooth delivers them, before the phone has stored them. That breaks the
rule that only `PageSink.ackableIndex` deletes audio from a device (`AGENTS.md`). An open draft firmware change
(BasedHardware/omi#20450, "ring custody", 3.0.22) frees only on the app's command. Until it ships, even a read-only
test deletes what it reads from the friend's pendant.

Real support is about M+M+S+S (one to two weeks of iPhone work) once the custody question is answered.

## Custody risk, accepted by the owner

"Accept the risk, properly document and warning in-app." On 3.0.21 the ring frees a record once Bluetooth delivered
it, every 2 s of a read, at its end and on disconnect. The app stores each record as it arrives, through the same
fsync'd page sink as the Limitless Pendant, and keeps storing what arrived even when the link drops. Only a phone that
dies, or an app that is killed, between receiving a record and its fsync loses it, and nothing can bring it back. The
app still ACKs (ADVANCE) only what `ackableIndex` allows. On a firmware that frees only on ADVANCE the rule holds
exactly: the drain carries on across a cleared ring only while the firmware frees on delivery (below), and otherwise
starts a fresh drain, so a held or conflicting record still stops the ADVANCE. The Pendant screen warns an Omi user while
the firmware frees on delivery.

## What the app does

- **Finding it.** Set up scans for the Limitless service and the Omi's audio service and takes the first pendant
  found. The services on the link say which it is (`DeviceKind`); the app keeps the kind with the paired pendant.
- **One drain, two codecs.** `DrainCoordinator` drains both through a `DeviceCodec`: the Omi's INFO answers both the
  identity and the status query, READ from the ring's oldest number is download mode, each record rebuilt from the
  data notifications is a page at its ring number, and ADVANCE to `ackableIndex + 1` is the ACK. The clock goes to its
  own characteristic. Live audio is never subscribed to.
- **Letting go.** After each drain the phone disconnects (`ConnectionState.resting`): an Omi drops its audio while a
  phone is connected without streaming. The next sync connects again: the app coming forward, the 5-minute
  foreground cycle, the Pendant screen, and the "Sync Life" shortcut. Nothing wakes the app in the background.
- **Its own slot.** Records are stored raw under the source id `omi-pendant`, so the server needs nothing new: any id
  but `import:` is a Pendant's. The page decoder reads a page by its source's kind (`DeviceKind.decodePage`).
- **One pendant per phone.** Pairing an Omi moves `CaptureStore.deviceID` to `omi-pendant`, so Limitless pages not
  uploaded yet stop uploading (they stay in the archive). Pair an Omi only on a phone without a Limitless Pendant.
- **Time.** A record's stamp is a whole second, when it was written. The timeline plays records back to back from a
  run's first stamp and starts again where a stamp jumps more than a second (`AudioPage.clockStepMillis`).
- **Flash lives.** A ring's numbers never fall, except when it is cleared and restarts at 0: a write number at or
  below the newest record the flash life holds starts a new life before anything is read. When the numbers don't
  show it (a cleared ring that wrote past what the phone holds), the first record clashes at a re-used number. While
  the firmware frees on delivery the ring can't send it again, so the clashing record and the rest of the read go
  into a new flash life and the drain carries on. On custody firmware it starts a fresh drain into the new life, as
  the Pendant does. Accepted: a link that drops between the clash and the new life (one SQLite write) leaves those
  records only as `replayConflict` incident evidence.
- **Holes.** Records the ring overwrote when full, or freed before the phone stored them, never come: the timeline
  breaks there. ADVANCE never crosses them.
- **Android.** `apps/android` drains an Omi the same way (clock, INFO, READ from the ring's oldest record, ADVANCE past
  what it fsync'd) and sends each record raw to the server under its own source, `android-omi`.
- **Left out.** The button, sound activity, pause and resume, the light, live audio: the Pendant screen and Settings
  hide the controls for a paired Omi. The heartbeat ignores the Omi's link and recording, and the Pendant screen
  otherwise shows it with the Limitless Pendant's words.

## Omi, as its firmware has it

Only the current consumer pendant ("CV1", nRF5340, firmware 3.0.20 or later) is worth targeting. The DevKits and an
older firmware use other storage commands, and Omi's own app picks the protocol by firmware version.

- **Services.** Audio `19B10000-E8F2-537E-4F6C-D104768A1214` (data `…0001` notify, codec `…0002`), time sync
  `19B10030` (write epoch seconds), storage `30295780-4301-EABD-2904-2849ADFEAE43` (control `…5781`, status `…5782`),
  button `23BA7924-0000-1000-7450-346EAC492E92` (single, double, long, down, up), standard battery and device info.
- **Codec.** Opus only: 16 kHz mono, 20 ms frames, CELT, 32 kbps. The codec characteristic reads 21 on CV1. Omi's
  public protocol page stops at 20, so it is out of date.
- **Live audio.** Each notification is a 16-bit packet counter (wraps), a fragment index and bytes. No timestamp, and a
  notification that fails three times is dropped. While a phone is subscribed, audio goes live only and never to
  storage. While a phone is connected but not subscribed, audio is dropped.
- **Offline ring.** Written only while no phone is connected, and only once the phone has set the clock. A record is
  444 bytes: UTC seconds, then Opus frames packed as length and bytes. About 480 MiB, roughly 30 hours. When full it
  overwrites the oldest and counts them as dropped; it doesn't stop recording.
- **Ring commands.** INFO (read and write numbers, dropped count), READ from a number, ADVANCE (free below a number),
  CLEAR, STOP. Data arrives in notifications not aligned to records. In 3.0.21 the firmware advances on its own every
  2 s of a read, at its end and on disconnect (`storage.c`, "Ring auto-advanced").
- **Firmware 3.0.22 (draft).** Only the app's ADVANCE frees. It can also keep live audio in the ring while streaming,
  gives the ring a random id (so a cleared ring is a new flash life), and flags timestamps that are uptime, not UTC.

## Against Life's pipeline

| Omi | Life | Fit |
| --- | --- | --- |
| Ring record, 64-bit number | a page, its index | Good: store the raw record as the page |
| READ from a number after reconnect | resend after a disconnect | Good: ask from the oldest page not stored |
| ADVANCE frees below a number | ACK frees at or below an index | Good: send `ackableIndex + 1` |
| 3.0.21 frees on delivery | only `ackableIndex` deletes | Conflict |
| Live notifications | pages | Poor: no durable number, lossy, not in the ring |
| UTC seconds per record | page time in ms | Coarse: count 20 ms frames from the stamp |
| Ring full overwrites | Pendant flash full stops | Different: dropped records become gaps |

Everything after the page store is generic already: `SourceStore`, `Timeline`, `DerivedAudioWorker`, the uploader and
the server, which knows only a source id and page numbers (`PUT /sources/{id}/speech/{firstPage}`). The
Pendant-specific code is `PendantProtocol/`, `CoreBluetoothTransport`, `DrainCoordinator`, `RecordingControl`,
`SoundActivity`, the press handling and the page decoder in `AudioPipeline/SourceAudio.swift`.

## What is missing

1. **Custody (decided: accepted, above).** Accept that a guest Omi on 3.0.21 loses a record if the phone dies
   between receiving and storing it, or require 3.0.22 (unreleased; flashing a friend's device is their call).
2. **Omi transport and drain (M).** Other UUIDs, the clock, INFO, READ, records rebuilt from the notifications, then
   ADVANCE. The transport seam assumes one control and one data characteristic, so widen it; don't fork
   `DrainCoordinator`.
3. **Record decoder (S).** Split the packed frames; the page decoder picks by source kind.
4. **Timing (M).** A record has a 1 s UTC stamp and no uptime. Place frames 20 ms apart from a run's first stamp and
   re-anchor when a stamp jumps (the mic sleeps in silence). Omi needs its own clock anchor.
5. **Flash lives (S).** On 3.0.21 a new life is read from INFO numbers that don't match the receipts; 3.0.22's ring id
   makes it exact.
6. **Live audio (skip).** On 3.0.21 the phone stays disconnected while the Omi records and connects only to drain. The
   button and sound activity are lost between drains.
7. **Server and screens (S).** A new source id is enough for audio. The heartbeat and the Pendant screen assume one
   Limitless device and should ignore the Omi.
8. **Battery and button (S, optional).** Standard battery service; one button characteristic. There is no start or
   stop recording command.

The friend's own Omi app must not drain the pendant at the same time: on 3.0.21 each read frees for everyone.

## Sources

- Firmware: `omi/firmware/omi/src/lib/core/{transport,storage,button,codec,config}.*`, `src/sd_card.c`, `omi.conf`.
- Omi's app: `app/lib/services/devices/ring_protocol.dart`, `connectors/omi_connection.dart`.
- BasedHardware/omi#7216 (ring buffer, merged 28 Jun 2026) and BasedHardware/omi#20450 (custody, open draft).
- Life: `docs/voice/pendant.md`, `PageSink.swift`, `Capture/`, `AudioPipeline/SourceAudio.swift`, `Upload/`.
