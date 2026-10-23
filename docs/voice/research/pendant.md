# Limitless Pendant BLE protocol — research for Life

Date: 2026-10-07. Built **only from public sources**:

| Key | Source | Pin |
|---|---|---|
| **OMI-DART** | [BasedHardware/omi `app/lib/services/devices/connectors/limitless_connection.dart`](https://github.com/BasedHardware/omi/blob/7cd4cc7b41192fdefa42a6eae38cf5a5deca2db7/app/lib/services/devices/connectors/limitless_connection.dart) | `7cd4cc7b`. Byte-identical on `main` (`1b38ecdc`, 2026-10-07) |
| **OMI-IOS** | Same repo: `app/ios/Runner/Limitless/LimitlessProtocol.swift`, `LimitlessFlashDrainEngine.swift`, `app/lib/.../limitless_clock_drift.dart`, `app/test/fixtures/limitless_golden/*.json` | `7cd4cc7b`. Identical on `main` |
| **PCLI** | [MAkcanca/pendant-cli](https://github.com/MAkcanca/pendant-cli/tree/5e0eace94042096a74944861cc4d60060cd3aa8f): `.proto` schemas reconstructed from the decompiled Android app and firmware v1.1.20 image, plus a Python client | `5e0eace9` = current `main`. The author says the capture/decode pipeline ran against a real pendant on fw 1.1.20 |
| **SDEL** | [sdelcore/pendant-cli](https://github.com/sdelcore/pendant-cli/tree/1c7165976d1113707f5b73550510ee5ddfd6a89b) `PROTOCOL.md`, `proto/pendant.proto` (from Android app v2.1.6) | `1c716597`. A simplified schema. It **contradicts PCLI in several places**. PCLI wins unless noted |
| **HELP** | Limitless help articles (still online 2026-10-07): [quick start](https://help.limitless.ai/en/articles/10619382-pendant-quick-start-guide), [LED colours](https://help.limitless.ai/en/articles/10542073-what-do-the-different-pendant-led-light-colors-mean), [factory reset](https://help.limitless.ai/en/articles/10547401-how-do-i-factory-reset-my-pendant) | — |

Tags used below: **[OMI]**, **[PCLI]**, **[SDEL]**, **[HELP]** = confirmed by that source. **[UNVERIFIED]** = inference, or sources disagree. No hardware observation from this owner's unit is used.

Copied for tests (public, MIT, with licences): `research-fixtures/pendant/omi-golden/*.json` (Omi golden vectors) and `research-fixtures/pendant/pendant-cli-proto/*.proto` (PCLI schemas). **The Omi golden RX fixtures are synthetic**: patterned bytes, with Opus placed in audio field 1 instead of the real field 4 (see §2.6). Use them for framing, reassembly and robustness tests, not as real audio. The TX vectors in `encoders.json` are exact.

---

## 1. GATT

| Item | UUID | Props | Source |
|---|---|---|---|
| Pendant service | `632de001-604c-446b-a80f-7963e950f3fb` | — | OMI, PCLI, SDEL |
| TX / control (phone → pendant) | `632de002-604c-446b-a80f-7963e950f3fb` | write + write-without-response | OMI, PCLI, SDEL (props: SDEL) |
| RX / data (pendant → phone) | `632de003-604c-446b-a80f-7963e950f3fb` | notify | OMI, PCLI, SDEL |
| Battery service / level | `0x180F` / `0x2A19` (standard, read + notify, 0–100) | read, notify | OMI (reads and subscribes), PCLI, SDEL ("reliable") |
| Unknown second service | svc `8d53dc1d-1db7-4cd3-868b-8a527460aa84`, char `da2e7828-fbce-4e01-ae9e-261174997c48` (write-no-resp + notify) | — | SDEL only, purpose unknown [UNVERIFIED]. Ignore |

- **Advertising.** The pendant advertises service `632de001` (PCLI scans by service UUID). SDEL gives the device name "Pendant". Whether the service UUID is always in the advertisement is [UNVERIFIED]. For foreground discovery, match on the service UUID **or** a name containing "Pendant" / "Limitless". Background scanning on iOS must filter by service UUID.
- **Bonding is required.** If the link is not bonded, writes to `632de002` fail with ATT error 5 (Insufficient Authentication), and the pendant ignores commands [PCLI, SDEL]. Pairing is "Just Works" [SDEL]. The pendant holds **one bond at a time**. If it is still bonded to another host (for example the official app), writes are silently dropped until it is factory reset (LED goes blue) [PCLI, HELP]. On iOS the first write or subscribe to an encrypted characteristic triggers the system pairing sheet.
- **MTU.** The official app requests ATT MTU 498, and its fragments carry about 470 payload bytes [PCLI]. On iOS the MTU is negotiated automatically. Use `maximumWriteValueLength(for: .withResponse)` for outbound fragment size. Inbound fragment sizes are whatever the pendant picks.
- **Write type.** PCLI picks write-with-response when the characteristic advertises it. Recommendation: use with-response for every command (especially ACK/delete), so the transport can sequence writes on `didWriteValueFor`.

### 1.1 Fragment envelope (both directions)

```
message BLEMessageFromNativeToPendant / BLEMessageFromPendantToNative {   // [PCLI common.proto, OMI, SDEL]
  uint32 index            = 1;  // varint  tag 0x08 — message id, monotonic per sender
  uint32 ble_fragment_seq = 2;  // varint  tag 0x10 — 0..num_fragments-1
  uint32 num_fragments    = 3;  // varint  tag 0x18
  bytes  payload          = 4;  // len     tag 0x22 — slice of the inner message
}
```

Every GATT write and every notification is exactly one envelope.

**Reassembly rules:**
- Key partial messages by `index`. When the count of distinct `seq` values equals `num_fragments`, concatenate the payloads in `seq` order [OMI, PCLI].
- Outbound: the pendant decodes once it sees `seq + 1 == num_fragments` (firmware handler disassembled by PCLI). So send fragments **in order**.
- Commands are small (≤ 30 B), so one fragment (`seq=0, num=1`) is always enough.
- **proto3 zero omission.** The pendant's encoder may omit `index=0` and `seq=0`. Default missing `index` and `seq` to 0, but treat a missing or zero `num_fragments` as malformed. Omi already defaults `seq` to 0 [OMI].
- Hardening (our requirements; Omi has none of this):
  - bound the number of open indices, the total bytes and the age of a partial;
  - reject a conflicting duplicate fragment (same index and seq, different bytes);
  - reject `seq >= num` and any change of `num` within one index;
  - drop all partials on disconnect or mode switch (Omi does too [OMI]).
- Outbound `index`: Omi starts at 0 [OMI], PCLI at 1 [PCLI]. Either works. Keep it monotonic per connection.
- **Never scan raw notifications for marker bytes.** Omi's button and status parsers look for `0x22` and then `0x42` / `0x2a` inside a single raw notification. That fails when a message spans fragments. Decode structured fields from the reassembled payload only.

---

## 2. Wire format

Plain protobuf wire format. Wire types used: 0 (varint) and 2 (length-delimited). The schemas declare no fixed32/64 fields. A strict decoder should still **skip** wire types 1 and 5 safely and reject 3, 4, 6 and 7. All integers are varints, with no zigzag (no `sint` types).

### 2.1 Command envelope: `ServerCommandMsg` (inner payload of TX fragments)

```
message ServerCommandMsg {                      // [PCLI server.proto]
  RequestData request_data = 30;                // tag f2 01 — Omi & PCLI always send it
  oneof content { ... field N = command ... }   // see table
}
message RequestData { int64 request_id = 1; bool do_not_ack = 2; }   // [PCLI]; OMI sends do_not_ack=0 explicitly
```

Omi encoding order: `<command field N, len-delimited> <field 30 RequestData>`. `request_id` starts at 1 and increments per write [OMI]. PCLI sets `do_not_ack=true` for fire-and-forget commands, so `do_not_ack=1` probably suppresses `ResponseData` [UNVERIFIED].

| N | Command | Body | Notes | Status |
|---|---|---|---|---|
| 3 | `SetLed` | `bool red=1, green=2, blue=3` | Probably manufacturing/test. Do not use | PCLI schema. SDEL disagrees (`int32 state`) [UNVERIFIED] |
| 6 | `SetCurrentTime` | `uint64 unix_timestamp_ms = 1` | Time sync | OMI, PCLI, SDEL ("verified working") |
| 7 | `DeleteFlashPage` (= ACK) | `uint32 older_than_or_equal_to_index = 1` | **Destructive.** Frees every page ≤ index | OMI ("up to index"), PCLI (name) |
| 8 | `DownloadFlashPages` (mode) | `bool batch_mode_enabled = 1; bool real_time_mode_enabled = 2` | `{1,0}` download flash, `{0,1}` live stream, `{0,0}` record to flash only | OMI, PCLI, SDEL |
| 10 | `FactoryResetPendant` | empty | Wipes flash and bond, reboots. **Never send** | PCLI |
| 11 | `ResetDevice` | empty | Soft reboot. Flash is kept | PCLI |
| 14 | `GetDeviceInfo` | empty | Reply is `PendantAllMsg.device_info`, often **without** an echoed request_id | PCLI, SDEL |
| 15 | `UnpairBluetooth` | `bool do_not_reset_device = 1` | | OMI, PCLI |
| 16 | `SetDebugFeatures` | see schema (`show_debug_led = 9`, …) | Do not use | PCLI |
| 17 | `StartRecording` | empty | | PCLI (implemented, one-way). SDEL: "may not work via BLE" [UNVERIFIED on our firmware] |
| 18 | `StopRecording` | empty | | Same as 17 |
| 21 | `GetDeviceStatus` | empty | Reply is `PendantAllMsg.device_status` | OMI, PCLI, SDEL |
| 24 | `SetVADThreshold` | `uint32 vad_threshold_ms = 1` | | PCLI. SDEL says `float threshold` [UNVERIFIED] |
| 25 | `ClearPendantStorage` | empty | Erases flash. **Never send** | PCLI |
| 26 | `SetLEDBrightness` | `uint32 brightness = 1` (Omi clamps to 0–100) | See §5 | OMI (sends it), PCLI |
| 27 | `SetDeviceOnShippingMode` | empty | | PCLI |
| 28 | `SetServerPublicKey` | `bytes server_pub_key = 1` | Turns on audio encryption (§3.6). **Never send** | PCLI |
| 1,2,4,5,9,12,13,19,20,22,23,29,31–34 | other | see `pendant-cli-proto/server.proto` | WiFi, real-time audio and firmware-update paths are "inert" on fw 1.1.20 per PCLI | PCLI |

**Byte-exact TX examples.** The first block is Omi `encoders.json`. I re-derived it with a 10-line encoder, and it matches byte for byte. The second block was generated with that same verified encoder.

Generic shape: `08 <idx> 10 00 18 01 22 <len> [ <tag N> <len> <body> f2 01 04 08 <rid> 10 00 ]`

```
msg6  SetCurrentTime(1750000000000) idx0 rid1 : 08 00 10 00 18 01 22 10 | 32 07 08 80 b8 83 a1 f7 32 | f2 01 04 08 01 10 00
msg8  {batch0,rt1} live          idx1 rid2 : 08 01 10 00 18 01 22 0d | 42 04 08 00 10 01 | f2 01 04 08 02 10 00
msg8  {batch1,rt0} download      idx2 rid3 : 080210001801220d420408011000f2010408031000
msg7  ACK ≤ 12345                idx3 rid4 : 08 03 10 00 18 01 22 0c | 3a 03 08 b9 60 | f2 01 04 08 04 10 00
msg21 GetDeviceStatus            idx4 rid5 : 08 04 10 00 18 01 22 0a | aa 01 00 | f2 01 04 08 05 10 00
msg8  {batch0,rt0} record-only   idx6 rid7 : 080610001801220d420408001000f2010408071000
--- generated with the same (verified) encoder ---
msg17 StartRecording             idx7 rid8 : 08 07 10 00 18 01 22 0a | 8a 01 00 | f2 01 04 08 08 10 00
msg18 StopRecording              idx8 rid9 : 08 08 10 00 18 01 22 0a | 92 01 00 | f2 01 04 08 09 10 00
msg26 SetLEDBrightness(0)        idx9 rid10: 08 09 10 00 18 01 22 0c | d2 01 02 08 00 | f2 01 04 08 0a 10 00
msg26 SetLEDBrightness(50)       idx9 rid10: 080910001801220cd201020832f20104080a1000
msg14 GetDeviceInfo              idx10 rid11: 080a1000180122097200f20104080b1000
```

Encoder notes:
- Field numbers ≥ 16 need a 2-byte tag: 17 → `8a 01`, 18 → `92 01`, 21 → `aa 01`, 26 → `d2 01`, 30 → `f2 01`.
- An empty sub-message is still written as `tag 00`.
- Omi writes zero values explicitly (`10 00`, `08 00`). That is legal protobuf, and the pendant accepts it [OMI].

### 2.2 Reply envelope: `PendantAllMsg` (inner payload of RX fragments)

```
message PendantAllMsg {                                   // [PCLI server.proto]; field numbers also in SDEL
  ResponseData response_data = 6;                         // tag 0x32, may accompany any content
  oneof content {
    DeviceInfoMsg          device_info               = 1; // 0x0a
    StorageBufferMsg       storage_buffer            = 2; // 0x12  ← flash pages (download AND live mode)
    SetCurrentTimeResponse set_current_time_response = 3; // 0x1a
    AuthenticateIngestMessage authenticate_ingest    = 4;
    DeviceStatus           device_status             = 5; // 0x2a
    BatteryStatus          battery_status            = 7; // 0x3a
    ButtonStatus           button_status             = 8; // 0x42
    RealTimeAudioData      real_time_audio_data      = 9; // inert on fw 1.1.20 [PCLI]
    RealTimeAudioAck       real_time_audio_ack       = 10;
  }
}
message ResponseData { int64 request_id = 1; ServerCommandRequestError error = 2; }      // [PCLI]
message ServerCommandRequestError { ServerCommandErrorCategory category = 1; string error_message = 2; }
enum ServerCommandErrorCategory { NONE = 0; FAILED_TO_EXECUTE = 1; }
```

- If `error` is absent or `category == 0`, no error was reported.
- SDEL has `ResponseData { int32 request_id = 1; bool success = 2; }`. That **conflicts** with PCLI. Decode field 2 as a sub-message. If it arrives as a varint, keep it as unknown/diagnostic [UNVERIFIED].
- PCLI matches replies by `request_id` first, then by oneof name, because `device_info` replies often lack `response_data`.
- The pendant also sends **unsolicited** `device_status` and `battery_status` during download [SDEL]. A status message without our `request_id` must never be treated as a command confirmation.

### 2.3 `StorageBufferMsg` (PendantAllMsg field 2): one flash page

```
message StorageBufferMsg {               // [PCLI]; OMI parses fields 2,4,5,6
  DeviceIngestType ingest_type = 1;      // varint
  int32  session          = 2;           // varint — storage session id (metadata, NOT a recording boundary) [PCLI]
  int32  run              = 3;           // varint
  int64  seq              = 4;           // varint — PCLI names it "page_seq_uptime_ms"; equals `index` on our unit
  int32  index            = 5;           // varint — flash page index; the ACK key
  bytes  flash_page       = 6;           // len — serialized FlashPage (§2.4); absent on error
  FlashPageError flash_page_error = 7;   // varint
}
```

- `ingest_type` enum. **The sources conflict:**
  - PCLI: `0 UNSPECIFIED, 1 REAL_TIME, 2 BATCH, 3 COMMAND` (3 carries Zephyr debug logs, not audio).
  - SDEL: `1 AUDIO, 2 LOG, 3 IMU`.
  - Omi ignores the field and classifies by content.
  - **Do not classify by `ingest_type`.** Classify by content: does the page contain audio (§2.6)?
- `flash_page_error` enum. **The sources conflict:**
  - PCLI: `0 NONE, 1 CRC, 2 IO`.
  - SDEL: `0 NONE, 1 READ_FAILED, 2 CORRUPT`.
  - Either way, a non-zero value means no usable `flash_page` bytes. Keep the raw envelope and surface it as a typed error.
  - Whether a re-read can succeed is unknown [UNVERIFIED].
  - Do not decide "safe to ACK past" from the enum alone; that needs an explicit policy decision.
- proto3 zero omission applies: `session=0`, `index=0` or `ingest_type=0` may be absent.

### 2.4 `FlashPage` (StorageBufferMsg field 6)

```
message FlashPage {                       // [PCLI flash_page.proto, SDEL]
  uint64 absolute_timestamp_ms = 1;       // tag 0x08 — pendant RTC, Unix epoch ms ("wall-clock when sealed" per PCLI)
  uint64 boot_uptime_ms        = 2;       // tag 0x10 — pendant uptime ms
  repeated Chunk chunks        = 3;       // tag 0x1a
}
message Chunk {                           // NOT a oneof — fields can co-exist [SDEL]; PCLI: "at most one populated"
  int32 time_offset_ms                    = 1;   // 0x08 signed, ms after the page timestamp (verified)
  PendantAudioData audio_data             = 2;   // 0x12
  ButtonStatus     button_status          = 3;   // 0x1a  (§4)
  WifiStatus       wifi_status            = 4;
  BleStatus        ble_status             = 5;
  BatteryStatus    battery_status         = 6;
  UsbStatus        usb_status             = 7;
  ImuData          imu_data               = 8;
  RecordingStatus  recording_status       = 9;   // 0x4a (§6)
  LogOutput        log_output             = 10;
  RuntimeStatus    runtime_status         = 11;
  StorageStatus    storage_status         = 12;  // 0x62
  CpuStatus        cpu_status             = 13;
}
message StorageStatus { bool did_start_storage_session = 1; bool did_stop_storage_session = 2; }   // [PCLI, OMI 0x62→0x08/0x10]
```

### 2.5 `PendantAudioData` (Chunk field 2)

```
message PendantAudioData {                // [PCLI, SDEL agree on numbers]
  bytes pcm_omni_mic_data             = 1;   // debug PCM (only with SetDebugFeatures)
  bytes pcm_directional_mic_data      = 2;
  bytes pcm_beamforming_data          = 3;
  bytes codec_beamforming_data        = 4;   // tag 0x22 — THE Opus packet (normal case)
  bytes codec_manual_beamforming_data = 5;   // Opus when manual beamforming debug is on
  bytes reserved_1                    = 6;
  bytes pcm_manual_beamforming_data   = 7;
  bool  did_start_recording           = 8;   // tag 0x40 — lifecycle marker
  bool  did_stop_recording            = 9;   // tag 0x48 — lifecycle marker
  int32 codec_type                    = 10;  // SDEL: 1=OPUS 2=PCM
  int32 num_frames                    = 11;
  int32 degree_of_arrival             = 12;
  EncryptedBytes encrypted_codec_beamforming_data = 13;   // only if a server key was pushed (§3.6)
}
message EncryptedBytes { bytes nonce = 1; bytes ciphertext = 2; bytes authentication_tag = 3; repeated int32 packet_offsets = 4; }  // [PCLI]; SDEL differs
```

**Lifecycle-only chunks.**
- `audio_data` may carry only fields 8 and/or 9, with no Opus. PCLI describes the pattern: pre-roll audio, then a start-marker chunk with no audio, then the body, then a stop-marker chunk with no audio.
- Omi reads 8/9 as start/stop recording [OMI `_parseFlashPageInfo`: `0x40`, `0x48`].
- The codec must accept an `audio_data` that contains only bool fields 8/9 as a valid, frame-less chunk.

**Which marker is the recording boundary? The sources conflict:**
- PCLI `flash_page.py`: `audio_data.did_*_recording` fires only for button-initiated recordings, while `storage_status.did_*_storage_session` fires for every recording, including VAD-initiated ones.
- PCLI `cli.py` splits on `did_stop_recording` and cites the official app's `isLastInSession`.

Keep both as metadata; do not hard-split on either alone [UNVERIFIED].

### 2.6 Opus extraction rule for our codec

- **One `codec_beamforming_data` (field 4) = one Opus packet.** Pass it verbatim to `opus_decode`.
  - PCLI writes each chunk's field 4 as one Ogg packet of 20 ms.
  - Omi's live parser looks for `0x22 <len> <TOC…>`, which is the same field 4 [OMI, PCLI].
  - SDEL says field 4 holds "raw concatenated frames without length headers" [conflicts; UNVERIFIED].
  - A single Opus packet can legally hold several frames (TOC code 1–3). libopus handles that, so never split field 4 yourself.
- **Do not copy Omi's heuristics.** Omi walks every length-delimited field recursively and keeps fields with length 10–200 and TOC ∈ {`b8 78 f8 b0 70 f0`}.
  - This drops packets shorter than 10 bytes. Opus DTX/silence packets can be 1–3 bytes (RFC 6716 §3.2.1), so those are lost.
  - It drops any other TOC value.
  - It accepts debug PCM that happens to start with a TOC byte.
  - Our rule: `field 4`, else `field 5`; any length ≥ 1; validate by decoding.
- Field 13 present means encrypted audio. Do not decode it. Fail the page as "encrypted" (§3.6).
- The Omi golden fixtures put synthetic frames in audio field **1** (`0a 28 …`). Fine for testing a field-agnostic walker; wrong for our strict field-4 rule. Adapt the expectations, or re-encode the frames into field 4 for our tests.

**Annotated inbound example** (Omi golden `single_fragment_audio_page.json`; synthetic frames):

```
08 0a | 10 00 | 18 01 | 22 eb 02                 envelope: index 10, seq 0, 1 fragment, payload 363 B
  12 e8 02                                        PendantAllMsg.storage_buffer (2), 360 B
    10 07 | 20 01 | 28 64                         session 7, seq 1, index 100   (ingest_type omitted = 0)
    32 df 02                                      flash_page (6), 351 B
      08 80 b8 83 a1 f7 32                        absolute_timestamp_ms = 1750000000000
      1a d5 02                                    Chunk (3), 341 B
        08 00                                     time_offset_ms 0
        12 d0 02                                  audio_data (2), 336 B
          0a 28 b8 87 8e …  (×8, 40 B each)       synthetic frames in field 1 (real firmware: 22 <len> <opus>)
```

Real-shape chunk (built from the schema; illustration only): `1a LL 08 <off> 12 LL 22 LL <TOC b8 …opus…>`. Lifecycle-only stop chunk: `1a 04 12 02 48 01`.

### 2.7 Status messages

```
message DeviceStatus {                        // PendantAllMsg field 5 [PCLI]
  WifiStatus     wifi_status      = 1;
  SetServerInfo  server_info      = 2;
  SetVADThreshold vad_threshold   = 3;
  uint32         led_brightness   = 4;        // readback for cmd 26 [PCLI schema; UNVERIFIED on hw]
  StorageState   storage_state    = 5;        // 0x2a
  PendantSyncMode sync_mode       = 6;        // 0 OFF, 1 BLE_BATCH, 2 BLE_REALTIME, 3 WIFI
  RecordingStatus recording_status = 7;       // 0x3a (§6)
  bool           has_all_fields   = 8;        // true ⇒ omitted scalars mean 0, not "unknown"
  BatteryStatus  battery_status   = 9;
}
message StorageState {                        // DeviceStatus field 5 [PCLI, OMI, SDEL]
  uint32 oldest_flash_page       = 1;         // 0x08
  int32  newest_flash_page       = 2;         // 0x10  (int32: may be -1 / < oldest when empty [UNVERIFIED])
  uint32 current_storage_session = 3;         // 0x18
  uint32 free_capture_pages      = 4;         // 0x20
  uint32 total_capture_pages     = 5;         // 0x28
}
message RecordingStatus { RecState recording_state = 1; RecSource recording_source = 2; uint32 vad_level = 3; }
  // RecState: 0 NOT_RECORDING, 1 RECORDING, 2 LISTENING   RecSource: 0 BUTTON, 1 AMBIENT_SOUND (VAD)  [PCLI, SDEL]
message BatteryStatus {                       // PendantAllMsg field 7, DeviceStatus 9, Chunk 6 [PCLI]
  State state = 1; int32 voltage = 2; int32 current = 3; int32 temperature = 4; int32 soc = 5;
  int32 capacity = 6; bool over_operating_temperature = 7; bool under_operating_temperature = 8; Usb usb_state = 9;
}
  // PCLI: state 0 DISCHARGING, 1 CHARGING, 2 FULL; usb 0 DISCONNECTED, 1 CONNECTED.
  // SDEL: state 0 UNKNOWN,1 CHARGING,2 DISCHARGING,3 NOT_CHARGING,4 FULL; usb 0 UNKNOWN,1 DISC,2 CONN.  → conflict [UNVERIFIED]
message SetCurrentTimeResponse {              // PendantAllMsg field 3 [PCLI]; SDEL: {bool success=1} (conflict)
  uint64 rtc_sync_relative_timestamp = 1; uint32 invalid_rtc_reset_count = 2; uint32 rtc_sync_session_number = 3;
}
message DeviceInfoMsg {                       // PendantAllMsg field 1 [PCLI]
  uint64 device_id = 1; string serial_num = 2; string firmware_ver = 3; uint32 storage_version = 4;
  uint64 storage_instance = 5; uint32 storage_run = 6; bytes wifi_mac_address1 = 7; bytes wifi_mac_address2 = 8;
  bytes ble_mac_address = 9; int32 oldest_flash_page = 10; int32 newest_flash_page = 11; int32 battery_percent = 12;
  SetDebugFeatures debug_features = 13; DeviceStatus device_status = 14; bytes device_audio_encryption_pub_key = 15;
  uint32 factory_reset_id = 16;
}
```

- Golden status packet (synthetic): `08 0f 10 00 18 01 22 17 | 08 55 | 2a 13 | 08 55 | 2a 0f | 08 64 10 c4 13 18 03 20 c0 a9 07 28 90 b0 0a`. This decodes to oldest 100, newest 2500, session 3, free 120000, total 170000. The path is envelope 4 → PendantAllMsg 5 → DeviceStatus 5.
- Battery percentage: prefer the standard `0x2A19` characteristic. Treat the charging enum as [UNVERIFIED] until it is seen on hardware.

---

## 3. Flash and page model

1. **Page indices.** Pages are identified by `StorageBufferMsg.index`. The device's range is `[oldest, newest]` from `GetDeviceStatus → storage_state`. If `newest < oldest`, there is nothing to drain [OMI drain engine]. Page count = `newest − oldest + 1` [OMI].
2. **Download.**
   - Send mode `{1,0}`. Pages are then pushed unsolicited, one `PendantAllMsg.storage_buffer` each [OMI, PCLI, SDEL].
   - Arrival in increasing index order is assumed by both clients [UNVERIFIED as a guarantee]. Hold out-of-order pages and never skip a gap.
   - Omi stops at `newest` from the status snapshot and returns to `{0,0}`. Pages recorded during the drain are picked up next cycle [OMI].
   - PCLI stops after 5 s with no message (an idle timeout).
3. **ACK = delete.** `DeleteFlashPage{older_than_or_equal_to_index = i}` frees **every** page ≤ i.
   - PCLI ACKs each page right after receipt.
   - Omi native ACKs the **maximum seen** index after an fsync, every 25 pages. If a page in between was missed, the up-to-index ACK deletes it.
   - Both say unacked pages are **re-delivered on the next download** [PCLI comment, OMI comment]. So duplicates must be expected and deduplicated.
4. **Sessions.**
   - `StorageBufferMsg.session` and `StorageState.current_storage_session` identify a storage session. PCLI: it is metadata, not a recording boundary.
   - `run` (page) and `storage_run`/`storage_instance`/`factory_reset_id` (DeviceInfo) exist. Their semantics across reboot, clear-storage and factory reset are [UNVERIFIED].
   - Whether `index` restarts after clear/factory-reset is [UNVERIFIED]. Assume it can, and include timestamp + session (and ideally `storage_instance`) in identity.
5. **Timestamps.**
   - `FlashPage.absolute_timestamp_ms` is Unix-epoch ms from the **pendant RTC** when the page **opened** (verified on the owner's unit; PCLI's "when sealed" is wrong).
   - `boot_uptime_ms` is uptime.
   - Chunk time = page ts + `time_offset_ms`. PCLI clamps negative offsets to 0. Verified: offsets are positive and count up through the page; only the first chunk can be -1 or -2 ms.
   - Sanity floor: treat ts ≤ `1577836800000` (2020-01-01) as invalid [OMI].
6. **Clock correction.**
   - `SetCurrentTime` affects only time written **afterwards**. Already-stored pages keep their RTC values.
   - Omi measures `drift = pendantEpoch − phoneNow` **before** sending SetCurrentTime. It reads the value from an RX message it calls "Type-8": `PendantAllMsg.8 → field 6`, which in the PCLI schema is `ButtonStatus.button_event_absolute_timestamp_ms`. So the pendant appears to emit a ButtonStatus at connect [UNVERIFIED].
   - Omi rejects |drift| > 7 days and applies `corrected = pageTs − drift` to offline pages [OMI].
   - Recommendation: store raw page ts plus the per-connection drift observation. Do not overwrite.
   - `SetCurrentTimeResponse.invalid_rtc_reset_count` may reveal RTC resets [UNVERIFIED].
7. **Reboot.** After a reset or a long-press restart, recording **cannot restart until the clock is synced**: the LED blinks red ×3 [HELP]. Omi therefore re-sends SetCurrentTime on every (re)connect before any mode command, and before every drain cycle [OMI].
8. **Storage full.** The LED blinks red ×10 and recording stops until the app syncs and is "fully caught up" [HELP]. Omi flags "almost full" when `free < 5% × total` [OMI].
9. **Audio format.**
   - Opus, **16 kHz, mono, 20 ms per packet** [PCLI "20 ms 16-kHz mono", OMI codec `opusFS320` = 320 samples @ 16 kHz, SDEL "16 kHz mono"; SDEL also says "~60 ms", which conflicts].
   - TOC `0xb8` is config 23 = CELT wideband 20 ms, mono, one frame (RFC 6716). That is consistent.
   - Decode at 16 kHz mono and count samples from `opus_decode`'s return value; do not assume.
   - For Ogg export, granule positions are counted at 48 kHz (960 per 20 ms) [PCLI].
   - Short DTX/silence packets (< 10 B) must be kept (see §2.6). Whether firmware emits them is [UNVERIFIED].
10. **Encryption.**
    - Off by default. It turns on only after `SetServerPublicKey` (ECDH P-256 → HKDF-SHA256 → AES-128-GCM per chunk, 12-byte nonce, 16-byte tag). The flag is RAM-only and is cleared by any reboot [PCLI, from firmware constants].
    - SDEL claims X25519/ChaCha20, which conflicts.
    - **Never send cmd 28.** If field 13 appears (a previous host pushed a key), report "encrypted; reboot pendant" and do not ACK.
11. **Live mode `{0,1}`.**
    - Omi streams this way in production. The payload has the same StorageBuffer/FlashPage shape, and the pendant "stops streaming after an extended period" unless the mode is re-sent. Omi re-sends once if no audio arrives within 8 s [OMI].
    - PCLI says BLE real-time is "inert" on fw 1.1.20. That conflicts [UNVERIFIED].
    - Whether live-streamed audio is also kept on flash is unknown.
    - Recommendation for v2: **flash download is the single audio path.** Use `{0,0}` between drains and `{1,0}` to drain.

---

## 4. Button

`ButtonStatus` [PCLI shared.proto]. It arrives live as `PendantAllMsg.button_status (8, tag 0x42)` and is stored as `Chunk.button_status (3)`:

```
message ButtonStatus {
  Button button_event = 1;                       // 0 NOT_PRESSED, 1 SHORT, 2 LONG, 3 DOUBLE, 4 SHORT_AND_SUPER_LONG
  bool   physical_button = 2;
  uint32 num_short_presses_since_boot = 3;
  uint32 num_long_presses_since_boot = 4;
  uint32 num_double_presses_since_boot = 5;
  uint64 button_event_absolute_timestamp_ms = 6; // pendant RTC epoch ms
  uint32 short_press_duration_ms = 7;
  int32  long_press_duration_ms = 8;
}
```

SDEL has `ButtonStatus { bool pressed = 1; }`. That conflicts; ignore it.

| Gesture | Effect | Source |
|---|---|---|
| Quick press | "Star a moment" (bookmark). Event 1 | HELP (gesture), PCLI (enum mapping) |
| Hold ~2 s | Turns recording **on/off**; the firmware toggles it itself. Event 2 | HELP. OMI ignores event 2 because "Limitless uses this to start/stop recording on device" |
| Double press | No official meaning. Omi maps it to its own app action | OMI |
| Hold until red, release | Recovery mode (solid red). Hold again until off to leave | HELP |
| Press-release, then immediately press-hold through purple | **Factory reset** (purple → off → blue). Deletes unsynced recordings. Likely event 4 | HELP. PCLI labels 4 "factory-reset gesture" |
| Solid red while unplugged after a reset attempt | Double-click too slow. Hold 10+ s until red clears | HELP |

**Offline presses stored on flash.**
- The schema has `Chunk.button_status`, and PCLI's parser extracts it from downloaded flash into an events sidecar [PCLI]. So presses made while disconnected can be recovered from flash.
- A press while paused (idle mode) is stored on flash and also sent live: verified on the owner's Pendant. Whether **every** press is stored is [UNVERIFIED].
- There is no "create bookmark" command.
- Counters reset on boot, so a counter alone is not an identity.
- Recommended identity: device + `button_event_absolute_timestamp_ms` + `num_short_presses_since_boot` + source page.
- Live and flash copies of the same press must merge to one event.
- **Never send a recording toggle in response to event 2**: it would undo the hardware toggle.

---

## 5. LED

Official meanings [HELP]:

| Light | Meaning |
|---|---|
| White | Recording |
| Orange / Green | Charging / fully charged |
| White alternating with orange / green | Recording while charging / full |
| Blue | Ready to pair (unbonded) |
| Purple | Factory reset in progress |
| Solid red | Recovery mode. Hold the button until red clears |
| Red ×3, 2 s pause, repeated once | Clock needs sync before recording can restart (after a reset or long press). Reconnecting the app re-syncs it |
| Red ×10, 1 s pause, repeated once | Out of memory. Sync fully before restarting recording |
| Red ×4, 5 s pause, continuous | Temperature out of range |
| Breathing red | Microphone init failure. Restart the device |
| Very rapid red, no pauses | Device init error. Enter recovery (hold until red, release), then exit (hold until off) |

**Brightness control:**
- Command 26 `SetLEDBrightness { uint32 brightness = 1 }` exists [PCLI schema].
- Omi sends it clamped to 0–100, advertises "LED dimming", and its getter returns a **cached** value with no device readback [OMI].
- Readback would be `DeviceStatus.led_brightness (4)` [PCLI schema].
- **Not verified by any source:**
  - whether current firmware applies it;
  - whether 0 turns the recording LED off;
  - whether it persists across reboot;
  - whether error colours obey it.
- Status: [UNVERIFIED]. Never use cmd 3 (`SetLed`), cmd 16 (debug LED) or StopRecording to darken the light.

---

## 6. Recording toggle and confirmation

- Hardware: a 2 s hold toggles recording [HELP]. App: cmd 17 `StartRecording` / cmd 18 `StopRecording`, both empty [PCLI implements them; SDEL doubts BLE support] [UNVERIFIED on our firmware].
- **Recording is separate from sync mode.** `{0,0}` / `{1,0}` / `{0,1}` choose where audio goes; they do not pause the microphone [OMI, PCLI].
- Confirmation (recommended state machine):
  1. Keep **requested** and **confirmed** state separately.
  2. Send 17/18 with a fresh `request_id` and `do_not_ack=0`.
  3. Wait for `ResponseData(request_id)` with no error. `category = 1` means FAILED_TO_EXECUTE.
  4. Send 21 and require a `device_status` **carrying our 21's request_id** whose `recording_status.recording_state` matches: 1 for start, 0 for stop. If the reply lacks request_id, accept only the first `device_status` after the 21 write [UNVERIFIED fallback].
  5. Handle timeout or disconnect by moving to an "unknown / retry" state, never to success.
- Decoding rules:
  - `DeviceStatus` without field 7 means **unknown**.
  - Field 7 present but empty, or `has_all_fields = true` with field 7's state omitted, means NOT_RECORDING (proto3 default).
  - `recording_source` 0 = BUTTON, 1 = AMBIENT_SOUND (VAD).
  - `LISTENING = 2` probably means VAD-armed, not writing [UNVERIFIED]. Do not map it to "recording" or "paused" without hardware evidence.
- A physical long press (event 2) is followed by a fresh status query, not by a command.
- Flash `Chunk.recording_status` and `did_start/stop_recording` are **historical**. They never describe the current state.

---

## 7. Capture invariants (requirements for v2, with the external evidence that motivates them)

1. **ACK only the contiguous durable prefix.**
   - Process pages strictly in index order from `oldest`. A page counts only after its raw `StorageBufferMsg` bytes are fsynced, file and parent directory included.
   - ACK `i` only when every page in `oldest…i` is durable.
   - A gap stalls the ACK; it is never skipped.
   - Why: ACK is up-to-index and destructive (§3.3). Omi's "max seen" ACK can delete a page that never arrived, and PCLI ACKs before decoding.
2. **Durability of non-audio pages.** These still count as "processed" once their raw bytes are durable:
   - diagnostic/log pages;
   - lifecycle-only pages;
   - button-only pages.
   Pages that carry `flash_page_error` or encrypted audio, or that look like audio but fail to parse, **stop** the ACK watermark until a policy decides. Omi also refuses to ACK past an "audio page with zero frames" [OMI].
3. **Dedupe identity** = `(deviceID, session, index, absolute_timestamp_ms)`, plus a SHA-256 of the raw bytes.
   - Re-delivery after a missed ACK is expected (§3.3).
   - Same identity and same hash: no-op. Same identity and different hash: stop and raise; do not ACK.
   - Consider adding `run` / `storage_instance` once observed.
4. **Generation fencing.**
   - Each connection gets a generation number, and each drain gets its own.
   - Any async completion (archive write, decode) must re-check both generations, and that the expected next index is unchanged, before it ACKs.
   - Clear fragment buffers, pending pages and drain state on disconnect or mode switch [Omi does the clearing].
5. **Background pending connect.**
   - Use CoreBluetooth state restoration (restore identifier), `willRestoreState`, and a long-lived `connect()` to the known peripheral, with no timeout.
   - On restore: re-discover services and re-subscribe `632de003` natively before any command.
   - Omi's iOS drain engine subscribes RX natively on device-ready, so the drain works after state restoration without the Flutter engine [OMI]. The remaining guarantees are Apple platform behaviour, not pendant protocol.
6. **Time push on connect.**
   - The first command after notify is enabled is `SetCurrentTime(nowMs)`.
   - Then `GetDeviceStatus`, then the mode command.
   - Repeat the time sync on every reconnect and periodically (Omi: every drain cycle, 90 s) [OMI, HELP red ×3].
   - Capture any pre-sync pendant clock reading as a drift observation (§3.6).
7. **Re-assert mode.** Re-send `{0,0}` after a drain and on reconnect; Omi re-sends mode on every reconnect [OMI].
8. **Serialize TX.** Send one command at a time with write-with-response and a per-command timeout. A successful GATT write proves delivery, not execution.
9. **Destructive commands are never sent:** 10, 11 (unless the user explicitly asks to reboot), 15, 25, 27, 28.

---

## 8. Verification status

VERIFIED rows were observed on the owner's Pendant (one drain of 254 pages; `docs/voice/pendant.md`, "Pages and
time"). Everything else comes from public sources only.

| Item | Status |
|---|---|
| Service/TX/RX UUIDs, battery 0x180F/0x2A19 | CONFIRMED-by-Omi/pendant-cli |
| Fragment envelope fields 1–4, reassembly by index | CONFIRMED-by-Omi/pendant-cli |
| Bonding required; one bond; error 5 when unbonded | CONFIRMED-by-pendant-cli (plus SDEL) |
| MTU 498 / about 470 B fragments in the official app | CONFIRMED-by-pendant-cli |
| Command wrapper + RequestData(30) byte encoding | CONFIRMED-by-Omi (golden TX vectors, re-derived) |
| Cmd 6 time sync, 7 ACK ≤ index, 8 mode {1,0}/{0,1}/{0,0}, 21 status | CONFIRMED-by-Omi/pendant-cli |
| ACK deletes every page ≤ index; unacked pages re-delivered | CONFIRMED-by-Omi/pendant-cli (claims in their code comments) |
| StorageBuffer fields 2,4,5,6 | CONFIRMED-by-Omi/pendant-cli |
| StorageBuffer 1 (ingest_type) and 7 (error) enum **values** | UNVERIFIED (PCLI and SDEL conflict). ingest_type was 2 on every page; no error seen |
| StorageBuffer 3 (`run`) counts boots; 4 (`seq`) equals the page index | VERIFIED on the owner's Pendant |
| StorageState fields 1–5 | CONFIRMED-by-Omi/pendant-cli |
| FlashPage 1 (epoch ms), 3 (chunks); Chunk 1/2/3/9/12 | CONFIRMED-by-Omi/pendant-cli |
| FlashPage 1 is the RTC when the page **opened**; Chunk time_offset = ms after it (0 to page length, first chunk may be -1/-2) | VERIFIED on the owner's Pendant |
| FlashPage 2 boot_uptime; within a boot RTC = uptime + an offset only a set changes | VERIFIED on the owner's Pendant |
| Opus in audio field 4, one packet per chunk, 16 kHz mono 20 ms | CONFIRMED-by-pendant-cli (+ Omi 0x22 live parser, opusFS320). Multi-frame packets UNVERIFIED |
| Short DTX packets (< 10 B) emitted by firmware | VERIFIED absent: 11,813 packets, 35–55 B, all TOC `0xb8`; silence stops recording instead |
| Audio lifecycle bools 8/9; storage_status session bools | CONFIRMED-by-Omi/pendant-cli. VERIFIED: every recording session opens with both start markers and ends with both stop markers; the firmware toggles them by itself every few seconds, so neither is a conversation boundary |
| Encryption only after cmd 28; RAM-only flag | CONFIRMED-by-pendant-cli (firmware analysis) |
| Live mode {0,1} delivers audio | CONFIRMED-by-Omi. Conflicts with PCLI "inert" → UNVERIFIED for our firmware |
| Cmd 17/18 start/stop recording | CONFIRMED-by-pendant-cli (implemented). Effect on our firmware UNVERIFIED |
| DeviceStatus.recording_status 7 (state/source/vad) | CONFIRMED-by-pendant-cli (schema). Live behaviour UNVERIFIED |
| ResponseData 6 {request_id, error{category,msg}} | CONFIRMED-by-pendant-cli (schema). Echo behaviour per command UNVERIFIED |
| ButtonStatus schema (live field 8, flash Chunk 3) | CONFIRMED-by-pendant-cli. Omi confirms event enum 0–3 and field 1 |
| Offline short presses stored on flash | CONFIRMED-by-pendant-cli (schema + parser). Completeness UNVERIFIED |
| 2 s hold toggles recording in firmware; quick press = star | CONFIRMED by Limitless help (official) + Omi |
| Pre-sync pendant clock via PendantAllMsg.8 field 6 (Omi "Type-8") | CONFIRMED-by-Omi (claim). Meaning UNVERIFIED |
| Clock-not-synced blocks recording restart | CONFIRMED by Limitless help |
| LED colour meanings | CONFIRMED by Limitless help |
| Cmd 26 LED brightness works / 0 = off / persists | UNVERIFIED (Omi sends it; no readback anywhere) |
| BatteryStatus (PendantAllMsg 7) enum values | UNVERIFIED (conflict) |
| Index reset semantics after clear/factory reset | UNVERIFIED. A reboot keeps indices (VERIFIED), restarts uptime, leaves the RTC unset, then restores it about 32 s behind until the next set |

---

## 9. Licensing

- **Omi (MIT).** If any code, field table or test vector is ported from BasedHardware/omi, ship this notice beside it. It is already copied at `research-fixtures/pendant/omi-golden/OMI-LICENSE.txt`. Name the pinned revision `7cd4cc7b41192fdefa42a6eae38cf5a5deca2db7` in a PROVENANCE note.

```
MIT License

Copyright (c) 2024 Based Hardware Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- **MAkcanca/pendant-cli (MIT, "Copyright (c) 2026 Mustafa Akcanca").** If its `.proto` files or field tables are vendored, keep `research-fixtures/pendant/pendant-cli-proto/PENDANT-CLI-LICENSE.txt` beside them.
- sdelcore/pendant-cli: nothing copied. It is cited only for conflicts.
- Limitless help content: summarized facts only, nothing reproduced.
