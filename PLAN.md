# Copilot: spoken help in the AirPods from what the Pendant hears

The owner's ask (3 Nov 2026): while a switch is on, what the Pendant hears is transcribed at once, straight from the
phone, and a project's copilot whispers short facts into his AirPods: on a Pendant press ("tell me now") or when he
hesitates. It answers only from that project's folder. The pipeline (pages, fragments, jobs, Life) is untouched.

The brain already exists: `~/Work/amelius-payment-recap/copilot` (Scribe Realtime + one warm `claude` session on the
Max subscription over `CONTEXT.md`, `POST /caption`, `POST /ask`, `/ws`). lifelog becomes its ears, button and voice.

## Milestone 1: the copilot speaks (amelius repo, branch `live-help`)

- [ ] `POST /scribe` → `{ url }`: a Scribe v2 Realtime WebSocket URL with a single-use token
      (`POST /v1/single-use-token/realtime_scribe`) and the copilot's own options (languages, keyterms, VAD 1 s).
      The phone never holds the ElevenLabs key and knows nothing of the project.
- [ ] Lines from the phone arrive on the existing `POST /caption` as speaker `Room` (anyone in the room, unattributed).
- [ ] `POST /now`: a spoken turn on what's pending; the answer goes out on `/ws` as `{type:"say", text}`.
- [ ] Spoken turns: the instructions gain an in-person section (Room lines) and a spoken rule: when the turn is marked
      spoken, one or two sentences, ≤ 25 words, the fact first, or `—` (nothing said).
- [ ] Auto, only for Room lines: a turn runs when a line hesitates (`isHesitation`, a regex: "I'm not sure", "I don't
      remember", "what was", "how much", "je ne sais pas"…), at most one spoken auto turn per 2 min. Meet mode unchanged.
- [ ] Reached from the phone over Tailscale only: `tailscale serve --https=8443` → `localhost:8787` (never Funnel).
- [ ] `bun test` covers `isHesitation`; a curl run proves `/scribe`, `/caption`, `/now` → `say`.

## Milestone 2: lifelog's Copilot (this branch)

- [ ] `Lifelog/Copilot.swift`, one job: carry live Pendant audio to Scribe and the copilot's words to the AirPods.
      - `poke()` on `onAudioSaved` (beside `sync.run`): new pages after its cursor (`PageScan.scan(afterSeq:)`,
        `ClockModel.load`, `SourceAudio.samples`), spans older than 20 s skipped, Float32 → PCM s16le 16 kHz,
        0.5 s base64 chunks to Scribe's socket (opened from `POST /scribe`, reopened when closed).
      - Scribe's `committed_transcript` → `POST /caption {speaker:"Room"}`.
      - `/ws` `say` → `AVSpeechSynthesizer` (session `.playback`, `.spokenAudio`, `.duckOthers`): AirPods.
      - `press()`: speaking → stop. Else commit Scribe's open line, wait ≤ 1.5 s for its text, then `POST /now`.
- [ ] `ButtonActions.handle`: while Copilot is on, a press goes to `Copilot.press` instead of the quick question.
- [ ] Settings: "Copilot" switch and the copilot's address (`@AppStorage`, this phone only).
- [ ] Docs: `docs/pendant.md` (the press while Copilot is on), `docs/decisions.md` (Copilot's sends: live audio
      phone → ElevenLabs while the owner's switch is on, the same exception as the press; text to his own copilot).
- [ ] `bun run check`, Release build, install on the phone (`install:phone -- --no-watch`), end-to-end test.

## Golden rule plan
Inventory: `rg -n "onAudioSaved|onPress|QuickPress|AVSpeechSynthesizer|URLSessionWebSocketTask|setCategory|copilot"`
in `apps/lifelog/apps/ios`: live pages reach the app only through `CaptureStore.onAudioSaved`
(`CaptureStore.swift:298`, set in `LifelogApp.swift:108`); presses only through `CaptureStore.onPress` →
`ButtonActions.handle` (`LifelogApp.swift:109`, `ButtonActions.swift:59`); decoding live pages is `PageScan`,
`ClockModel.load`, `SourceAudio` (`AudioPipeline/SourceAudio.swift:7,75,123`); the one audio session user is
`PlaybackStore.swift:137`. No WebSocket, no speech synthesis, no "copilot" in lifelog today. The copilot side:
`server.ts` (`accept`, `maybeAsk`, `/caption`, `/ask`, `/ws`), `transcript.ts:56` `shouldTrigger`, `knowledge.ts`
`INSTRUCTIONS`, `audio.ts` (Scribe options).
Shape: the phone is generic, the project is the copilot's. What to transcribe with (Scribe's options and keyterms)
and when to speak (`shouldTrigger`, spoken rule) are decided once, in the copilot; the phone only streams, posts lines
and speaks `say`. The press still has one entry (`ButtonActions.handle`), which routes by the switch. Scribe's options
move from `audio.ts` into one `SCRIBE` constant both `audio.ts` and `/scribe` read.
State: the switch and the address: global per phone (`@AppStorage`). Copilot's page cursor, sockets and speaking state:
owned by the one `Copilot`, for the app's life. Copilot's last auto turn time: the copilot server, per call.
Deletes: `audio.ts`'s inline Scribe options (moved to the shared constant). Nothing else is replaced.
Net lines: lifelog +230 / −0 (one file ~200, wiring and Settings ~20, docs ~10); copilot +80 / −10.
Plan review: pending
