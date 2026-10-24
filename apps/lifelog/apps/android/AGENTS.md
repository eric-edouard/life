# apps/android

The Android app: a thin phone. It pairs with the server, drains an Omi over Bluetooth, keeps each record on disk and
sends it raw to the server, which decides what is speech and what gets transcribed (`docs/sync.md`, "Raw pages from a
thin phone"). One status screen. Kotlin, Jetpack Compose, Android 13 (API 33) and later.

## How to

```sh
cd apps/lifelog/apps/android
./gradlew testDebugUnitTest assembleDebug       # the gate's step; needs JDK 17+ and the Android SDK
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The SDK is found through `ANDROID_HOME`, else `~/Library/Android/sdk`; the gate skips the step without one.

## Worth knowing

- `api/` is the server's client, generated at build time from the whole `apps/server/openapi.json`
  (`api/build.gradle.kts`). Nothing generated is committed: a contract change needs only a rebuild.
- Omi only. The Limitless Pendant speaks another protocol (protobuf fragments, `apps/ios/Kit/Sources/PendantProtocol`);
  porting it is a project of its own. Read `docs/research/omi.md` first, as for any Omi work.
- `Omi.kt` ports the ring commands and notifications of the iPhone's `Omi.swift`; both test suites read
  `fixtures/wire/omi-ring.json`, so a drift fails the gate. The phone never reads inside a record; the server does.
- The source id is `android-omi`, never the iPhone's `omi-pendant`. Page indices are the flash life times 2^40 plus the
  ring number; a write number at or below the newest stored record starts a new life (`Store.newLife`).
- A drain reads from the ring's oldest record, never past it, and ADVANCE (the ACK) goes only to
  `DrainedRun.advanceTo`: one past the run of records the outbox fsync'd from the read's start, never across a hole.
  CLEAR is not representable. Firmware 3.0.21 frees records on delivery anyway; the owner accepted that risk.
- The outbox is one file per drain; a file goes once the server answered 200 for its last batch. Cycles never overlap,
  even across a service stopped and started again (`SyncService.cycleLock`).
- A record leaves the outbox only on a 200. A 409 `page_conflict` means a cleared ring the drain missed (or a reinstall
  that forgot its band). It names the first index holding other bytes: that page and every later page of its band move
  to a new band (`Uploader.rebanded`), as the iPhone re-bands a clash; the pages before it go again as they are, which
  the server accepts once, so nothing is stored or paid for twice. The owner chose this on 22 Oct 2026.
  That holds while the firmware frees on delivery (3.0.21): once custody firmware ships, the iPhone re-bands only on
  such firmware (`DeviceKind.carriesDrainIntoNewLife`), and Android must check the firmware the same way.
- Sync does not restart after a reboot: the owner opens the app and starts it again.
- The service connects only to drain, every 5 minutes: an Omi drops its audio while a phone holds the link without
  streaming. A wakelock is held only during a cycle.
- The brand is Life's (eric-edouard/life, `docs/brand.md`): colours copied in `Brand.kt`, Source Serif 4 and IBM Plex
  Mono bundled (OFL, licences in `fonts/`), the L in the icon only.

## Hand check on a real phone

1. Enable USB debugging on the phone, plug it in, then `adb install -r app/build/outputs/apk/debug/app-debug.apk`.
2. Open lifelog, tap "Scan the pairing code", scan the QR code Lifelog Host shows, confirm "Pair".
3. Tap "Start syncing" and grant Nearby devices and Notifications. Keep the Omi near the phone and away from any other
   phone's Omi app.
4. Record a minute on the Omi, wait for a cycle (up to 5 minutes): Recorder says "Drained N records", Queue goes to 0
   and Last upload shows the time.
5. On the Mac, `GET /sources/android-omi/ingest` shows `highestPage`. Transcripts follow once the server processes page
   sources (`docs/processing.md`).
