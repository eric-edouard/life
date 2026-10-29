# Context router: find Thai from the whole block, with the bar set by where the owner is

Goal (owner, 29 Oct 2026): the best transcription for every language, wherever he is. Today a turn goes to Scribe
when VoxLingua's top guess is Thai, and a block 10% Thai goes whole: 11% of Thai is missed. A bench on 310 real
blocks (4,897 turns, 20 days, each model scored on a day it didn't train on) found that a small logistic model on
VoxLingua's scores plus the rest of the block misses 2–4%. Place must be the bar, not a feature: a learned place
feature lost 47% of Thai spoken abroad.

## Milestone 1: the router in production

- [x] `apps/identity/app.py`: each judged turn also returns `scores: {en, fr, th}`, VoxLingua's probabilities
      (`classify_batch(...)[0][0].exp()`), next to `language` (still its top guess). Contract test and fixture.
- [x] `speech-service.ts` `Heard`: `scores` per turn, nullable like `language` (null for a turn under a second) and
      required otherwise. Server and speech service ship together in Lifelog Host: an answer without it fails zod
      like any malformed answer. No fallback to the top-guess rule.
- [x] `route-turns.ts`: `thaiChanceOf(turn, judged, words)`: a logistic over 7 features (log Thai, log EN+FR, log
      the rest, Parakeet wrote nothing, log seconds, the rest of the block's Thai and not-EN/FR shares, weighted by
      seconds). Weights are constants fitted by the bench, with the fit's date, n and leave-one-day-out score in a
      comment (seven floats identify no one; no per-day or per-job figures are committed). `routeTurns(heard, zone)`: a judged turn is routed when its
      chance ≥ the bar (0.3 where Thai is spoken, `THAI_ZONES`; 0.7 elsewhere); a block whose routed seconds are
      ≥ 50% of judged goes whole. `toScribe` and `SCRIBE` are deleted (only the router decides).
- [x] The zone he was in when the block was recorded, not now (a block can wait hours: an outage, credits out):
      `ownerZoneAt(db, at)` in `diagnostics.ts`, the newest heartbeat naming a zone at or before `at`, else the newest
      one. `refreshOwnerTimeZone` becomes `ownerZoneAt(db, now)`. `jobs.ts` routes with the block's start, and the
      `speech.heard` event records the zone and bar used.
- [x] Tests: route-turns (a clearly Thai block goes whole anywhere; a Thai turn in an English block is routed at
      home and abroad; a chance between the bars is routed at home only; turns under a second never routed);
      `ownerZoneAt` at a past instant after a later heartbeat moved on; the identity contract fixture carries `scores`.
- [x] Docs: `processing.md`, `decisions.md` (the owner's goal, the bench, why place is a bar).

## Milestone 2: the bench in the repo (replaces my scratch Python)

- [x] `stt-bench/src/context.ts`, step `bench context`: reads sampled jobs read-only, re-hears each block through the
      running speech service (cached per job and the service's `models` provenance; retries on busy), labels each turn by Scribe's stored words, and reports, per kind of
      place: Thai missed, EN/FR sent, share of audio sent to Scribe, for `routeTurns` as it is. `bench context fit`
      fits the weights (logistic regression by gradient descent, leave-one-day-out) and prints them.
- [x] Delete what it replaces: `route`, `judge`, `guessLanguages`, `routed`, `silent`, `local/lid.py`; and
      `pipeline` + `compose` + `rerun`, the Thai options of `MODELS`, `local/run.py`'s `turns` option and the
      `DIARIZER` default (its question, which Thai model, was settled for Scribe on 23 Oct; numbers stay in
      `docs/research/transcription-bench.md`), with their tests in `routing.test.ts`. Update `stt-bench/AGENTS.md`,
      `bench.ts`'s usage header and the research doc's step names.

## Milestone 3: iterate

- [x] The speech service's 500 on ~29-minute blocks: Parakeet on MLX ran out of GPU memory; decoded in 10-minute
      pieces (#273). Done before the bench, which re-hears long blocks.
- [ ] Each round: bench, change one thing, bench again; numbers in issue #241.

## Golden rule plan

- **Places that decide the same thing:** `route-turns.ts` (`routeTurns`, `toScribe`, `SCRIBE`, `WHOLE_BLOCK`,
  `MIN_ROUTED_SECONDS`), `stt-bench/src/routing.ts` (`routed`, `compose` call `routeTurns`/`toScribe`),
  `stt-bench/src/bench.ts` (`route`'s detector list), `identity/app.py` `language()`, `speech-service.ts` `Heard`.
  `heartbeats` → `refreshOwnerTimeZone` (`diagnostics.ts`) for the zone; `jobs.ts` `waitForCredits` and the
  `speech.heard` event; the bench's docs and `local/run.py`. `transcriptOf` reads `language` only to name the block's language (unchanged). Found with
  `rg -n "toScribe|routeTurns|MIN_ROUTED_SECONDS|voxlingua|\.language\b" apps/lifelog/apps`.
- **One source of truth:** `routeTurns` decides what goes to Scribe, in production and in the bench (the bench
  imports it). Weights live once, in `route-turns.ts`. Place enters only as the bar.
- **Deletes:** `toScribe`, `SCRIBE`, the bench's `route`/`judge`/`guessLanguages`/`routed`/`silent`/`pipeline`/
  `compose`, `local/lid.py`, and most of `routing.ts`.
- **Net lines:** about +250 / −300.
