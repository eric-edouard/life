# ElevenLabs Speech-to-Text (Scribe): research, 2026-10-07

Sources: the official docs, read from their raw `.md` versions on 2026-10-07, the live pricing page, and the official Python SDK source. Anything marked **[unverified]** has no official source. Those items are collected in section 10.

## 1. Models

| id | status | use |
|---|---|---|
| `scribe_v3` | current batch model, launched 2026-11-10; $0.20/h, same API | **use this** (since 11 Nov 2026) |
| `scribe_v2` | batch model, launched 2026-01-09; still available | used until 11 Nov 2026 |
| `scribe_v2_medical` | batch fine-tune for clinical audio; same price and API | not relevant |
| `scribe_v2_realtime` | WebSocket, ~150 ms latency, $0.39/h | not needed |
| `scribe_v1` | **deprecated** ("outclassed"; replacement is `scribe_v2`) | do not use |

Scribe v3 (10 Nov 2026) claims 27% fewer word errors than v2 over 102 languages (Thai 28%, English 23%) and 12% fewer speaker errors; on the owner's test set it lost to Nemotron 3 at splitting Scribe v2's merged voices and won a blind Thai listening test against v2, 3 to 1 with 6 ties (11 Nov). ([models](https://elevenlabs.io/docs/overview/models), [STT overview](https://elevenlabs.io/docs/overview/capabilities/speech-to-text))

## 2. Sync vs async, webhooks, retrieval, idempotency

- **Sync** (the default) returns `200` with the transcript. `transcription_id` and `audio_duration_secs` are in the body.
- **Async:** send `webhook=true` and the request returns `202` early with `{message, request_id, transcription_id?}`. ([convert](https://elevenlabs.io/docs/api-reference/speech-to-text/convert))
  - `webhook_id` targets one webhook. Without it, the result goes to **all** STT webhooks.
  - `webhook_metadata` is a JSON string, at most 16 KB and 2 levels deep, and is echoed back in the callback.
  - Create the webhook under Dashboard → Developers → Webhooks with the event **Transcription completed**, or with `POST /v1/workspace/webhooks` (auth `hmac`; the response returns `webhook_secret`).
- **Payload** ([guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/webhooks)):

  ```
  {type:"speech_to_text_transcription", event_timestamp, data:{request_id, webhook_metadata, transcription:{language_code, language_probability, text, words[…]}}}
  ```

  The same page's sample code checks `speech_to_text.completed` and a `status: failed` field. That is inconsistent with the payload above, and **the shape of a failure callback is undocumented**.
- **HMAC** ([webhooks](https://elevenlabs.io/docs/eleven-api/resources/webhooks), [SDK source](https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/webhooks_custom.py)):
  - The header is `ElevenLabs-Signature: t=<unix>,v0=<hex>`.
  - Compute `hex(HMAC_SHA256(secret, "<t>.<raw body>"))` over the **raw** body and compare it to `v0`.
  - Reject the request if `t` is more than **30 min** old.
  - Verification is not enforced by ElevenLabs; the receiver must do it.
- **Delivery:**
  - Respond 2xx quickly. A 4xx is not retried; 5xx, 429 and 408 are retried.
  - Retries are **off by default**. When enabled, a delivery is attempted 5 times: immediately, then after 30 s, 2 min, 8 min and 30 min. The docs list retry support only for Agents post-call events, so retries for STT are **[unverified]**.
  - A webhook is auto-disabled after 10 or more consecutive failures if its last success was more than 7 days ago.
  - Retried payloads are identical to the original, so the handler must be **idempotent**. Dedupe on `request_id`.
- **Get by id:** `GET /v1/speech-to-text/transcripts/{transcription_id}`. `DELETE` on the same path removes it. ([get](https://elevenlabs.io/docs/api-reference/speech-to-text/get), [delete](https://elevenlabs.io/docs/api-reference/speech-to-text/delete))
  - **Retention period: not documented [unverified].**
  - It is not documented whether GET returns a status or 404 while an async job is still running [unverified].
  - There is no endpoint to look up a transcript by `request_id`.
- **Idempotency keys:** none exist in the API. The errors page offers only a `request_id` for support. ([errors](https://elevenlabs.io/docs/eleven-api/resources/errors))
- **Client disconnect during a sync request:** undocumented. Assume the job **may complete and be billed** [unverified]. Webhook mode removes this window, because the 202 (with `request_id`) returns before processing.
- **SDK note:** SDK `maxRetries` resubmits 5xx/429 responses, which can bill twice for a paid POST. Disable it for convert calls.

## 3. Language

- `language_code` takes ISO-639-1 or ISO-639-3 and is optional. When it is omitted, Scribe auto-detects.
- The response has a **single file-level** `language_code` and `language_probability`. There is **no per-word language field**.
- **Code-switching:** ElevenLabs says you "can send audio that contains multiple languages in a single file… automatically detects each language… without manual segmentation" ([launch blog](https://elevenlabs.io/blog/introducing-scribe-v2)). No figures are published for EN/FR/TH switching specifically.
- **Thai** is in the "Good" tier (WER over 10% and up to 20%). English and French are in the "Excellent" tier (5% or below). Thai produces no `spacing` tokens, so rebuild text by concatenating tokens, spacing tokens included.
- **Silent translation:** there is no translate option, and the docs say nothing about it. Forcing the wrong `language_code` on mixed audio risks output being transliterated or translated into that language [unverified; the common failure mode for Whisper-class models]. **Never send `language_code` for mixed audio.**
- `transcript_edit` rewrites text through an LLM. It costs +30%, and its output goes to `edited_transcript`. Don't use it.

## 4. Diarization, timestamps, events

- `diarize` defaults to false.
- `num_speakers` sets a **maximum** of up to **32**. When omitted, the model's own maximum is used.
- `diarization_threshold` (default ≈0.22) can only be set when `diarize=true` and `num_speakers` is null. Raising it gives fewer splits of one person and more merges of different people.
- `speaker_id` labels (`speaker_0`, …) are **per request only**. Linking speakers across chunks must happen locally, for example with ECAPA embeddings.
- `use_speaker_library` exists (matches speakers against a workspace library). It is not needed here and voiceprints should stay local.
- `detect_speaker_roles` labels agent/customer at +10%. Not needed.
- `timestamps_granularity` accepts `word` or `character`. Character mode adds a per-character timing array to each word. Each word also has a `logprob`, which is useful for detecting hallucinations or low confidence.
- `tag_audio_events` produces `type: audio_event` tokens such as (laughter). Its default is not stated, so **send it explicitly**.

## 5. Keyterms

- The parameter is `keyterms` (repeated form field).
- Batch limits: up to **1000** terms, each **under 50 characters** and **at most 5 words**. The characters `< > { } [ ] \` are not allowed.
- Price: **+$0.05/h** on the pricing page. The API reference instead says "+20% surcharge", which would be $0.044/h; the two disagree.
- **More than 100 terms imposes a 20 s minimum billable duration per request.** ([keyterms](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/keyterm-prompting))
- On false insertions, the docs only claim the model "relies on the context to decide whether to transcribe that term". **There is no official guidance and no published false-insertion rate.** Test with negative samples, as the handoff's "false-hint tests" plan requires.

## 6. Limits and input

- File upload: **less than 5.0 GB** per the API reference. The overview/FAQ says **3 GB**; plan for 3 GB to be safe.
- Minimum audio length: 100 ms.
- Maximum duration: **10 h**. In multichannel mode the overview says 1 h while the FAQ says the channel total must be under 10 h; the docs disagree.
- Formats: AAC, AIFF, **OGG, Opus**, MP3, WAV, **FLAC**, **M4A/MP4 audio**, WebM, plus common video containers.
- `file_format=pcm_s16le_16` takes raw 16 kHz mono little-endian PCM for lower latency. Use `other` for any container.
- `source_url` takes an HTTPS URL. It replaces `cloud_storage_url`, which is **deprecated** and capped at 2 GB.
- `use_multi_channel` supports up to 5 channels, each billed at the full duration.
- Files longer than 8 min are split internally into up to 4 parallel parts.
- Concurrent requests per plan: Free 8, Starter 12 (ours), Creator 20, Pro 40, Scale/Business 60. A file over 8 min takes min(4, ceil(seconds / 480)) of them. ([concurrency FAQ](https://elevenlabs.io/docs/help-center/product/core-capabilities/speech-to-text/how-many-speech-to-text-requests-can-i-make-and-can-i-increase-it))
- Regional hosts exist, including `api.sg.residency.elevenlabs.io`. Whether a non-enterprise account can use them is **[unverified]**.

## 7. Pricing (live, [pricing/api](https://elevenlabs.io/pricing/api), 2026-10-07)

| item | price |
|---|---|
| Scribe v3, v2 / v2 Medical batch | **$0.20 / audio-hour** (confirmed 2026-11-11; v2 was $0.22 on 2026-10-07) |
| Scribe v2 Realtime | **$0.39 / hour** (confirmed) |
| Keyterm prompting | +$0.05 / h |
| Entity detection | +$0.07 / h |
| Transcript edit | +30% |
| Speaker roles | +10% |
| Multichannel | × number of channels |

- These prices are the same on every tier. Each plan includes some hours, for example Pro includes 450 batch hours.
- Billing is by **duration of audio submitted** (`audio_duration_secs`). Silence counts toward that duration, so removing it saves money. Compression reduces bytes, not billed time.
- The documented minimums are 20 s per request when more than 100 keyterms are sent, and 100 ms of audio. Any other per-request minimum or rounding rule is **[unverified]**.

## 8. Retention and privacy

- `enable_logging` is a query parameter, default `true`. Setting it to `false` enables **Zero Retention Mode**: no logs and no transcript storage, which presumably also disables `GET /transcripts/{id}`.
- ZRM is **enterprise-only** and covers API traffic only. ([ZRM](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode))
- For a personal plan, expect transcripts to be stored server-side. Remove them after ingest with `DELETE /v1/speech-to-text/transcripts/{id}` if desired.

## 9. Recommendation for lifelog

1. **Model:** `scribe_v3` batch only.
2. **Request fields:** `diarize=true`, no `num_speakers`, `timestamps_granularity=word`, `tag_audio_events=false`, `no_verbatim=false`, and **no `language_code`**. Code-switching relies on auto-detect.
   - Detect language per turn locally. For Thai, check the Unicode range U+0E00–U+0E7F. For EN vs FR, use a small text language-ID model.
   - Store `logprob` with each word.
3. **Async mode:** `webhook=true` with `webhook_id` set and `webhook_metadata={job_id, upload_plan_id, sha256}`.
   - Insert the ledger row before the POST.
   - Persist `request_id` and `transcription_id` from the 202 response.
   - The webhook handler verifies the HMAC on the raw body (30 min window), dedupes on `request_id`, and returns 2xx quickly.
   - A sweeper calls `GET /transcripts/{transcription_id}` to reconcile jobs that haven't completed.
   - Never auto-resubmit when the outcome is ambiguous: no 202 received, or a 5xx after the upload. Write a pending marker before the upload and refuse to resubmit while it is there; the owner approves any resubmission.
4. **Preparation:** upload a speech-only rendition built by VAD.
   - Keep any non-speech span shorter than about 1–2 s.
   - Join spans with about **0.3–0.5 s of real or padding silence** so words aren't spliced together.
   - Store a piecewise time map from upload time to original time and remap word start/end with inward rounding (as the old `SpeechUploadPlan.swift` does).
   - Encode as **Opus/OGG at ~24–32 kbps mono** or as FLAC. Both are accepted, and both are far smaller than WAV for cellular uploads.
5. **Chunk size:** one conversation per request, capped at about **20–30 min of cleaned speech**.
   - Longer chunks give better language and diarization context. Anything over 8 min is parallelized server-side anyway.
   - Shorter chunks reduce the cost of a failure and the latency.
   - Avoid fragments under about 20 s: diarization and language detection get weak, and the 20 s keyterm minimum applies.
   - Link speakers across chunks with local embeddings.
6. **Keyterms:** at most about 50–100 owner-curated proper nouns (people, places, Thai names in Thai script plus romanized forms). Stay at or under 100 to avoid the 20 s minimum, and A/B test for false insertions before enabling by default. That adds about 23% to the base cost.
7. **Expected cost:** $0.22 per cleaned speech-hour, or $0.27 with keyterms. Enforce the monthly hours cap server-side using `audio_duration_secs` from each response.

## 10. Unverified or contradictory (verify empirically)

- How long transcripts are retained for `GET /transcripts/{id}`, and whether GET works while an async job is still running.
- Whether a sync request is billed and completed if the client disconnects.
- The webhook failure payload and event `type` (the docs contradict themselves), and whether STT webhooks honor the retry setting.
- Whether forcing `language_code` on mixed audio translates or garbles the off-language speech, and how well EN/FR/TH code-switching works within one utterance. No vendor benchmark exists for this pair.
- The size of Thai `word` tokens (how Thai text is segmented into words) and the accuracy of their timestamps.
- Keyterm price ($0.05/h vs +20%) and false-insertion behavior.
- Maximum file size (3 GB vs 5 GB) and the multichannel duration limit (1 h vs 10 h).
- Any billing granularity or rounding beyond the documented minimums.
- The default of `tag_audio_events`.
- Whether non-enterprise accounts can use the Singapore residency host.
