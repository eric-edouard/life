# apps/transcription-bench

Measures what replacing ElevenLabs Scribe with open models run on the Mac would cost in quality:
text (English, French, Thai, mixed), language detection and who spoke. Scribe's transcript of each
clip is already stored and is the reference. What it found: `docs/research/transcription-bench.md`.

## How to run it

`bun run --cwd apps/transcription-bench bench <step>`, in order: `jobs`, `sample`, `clips`, `run [model…]`,
`score`, then `route [diarizer]` (finding the other languages on that diarizer's turns, pyannote's by
default; needs its run and Parakeet Ultra's; caches and report in `routing/<diarizer>/`) and
`pipeline [thai model]` (the proposed pipeline on pyannote's turns, scored like a model). Each step skips what it already
wrote, so a step can be stopped and run again.

- `jobs` and `clips` read the archive read-only through `@life/voice-db` (`src/export.ts`):
  `DATABASE_PATH` and `AUDIO_DIR` as Lifelog Host's `server.env` sets them.
- `run` needs `uv` (`local/`, Python, mlx-audio) and, for `pyannote`, `HF_TOKEN` with the model's
  terms accepted once on Hugging Face; for `nemotron-diar`, NVIDIA's `nemo-speech` binary on PATH or
  in `NEMO_SPEECH` (NeMo-Speech.cpp's release for this machine). Models download on first use, and
  run one at a time.
- `scribe-th` is Scribe through its API (`local/scribe.py`, `ELEVENLABS_API_KEY`): it spends
  ElevenLabs credits, so `run` without names skips it. Ask the owner before running it.
- Everything it writes holds the owner's voice or words: it lives in `~/Life/docs/lifelog/stt-bench/`
  (`STT_BENCH_DIR` to move it), never in the repo.

## Worth knowing

- One error rate for every language (`src/score.ts`): words for Latin script, characters for Thai.
  Hesitations ("euh", "um") and stutters ("the the", "en-entering") never count.
- Drift (`wordErrors`) is what matters for a memory: a word that is not small dropped, added or
  replaced by a really different word (not a near-spelling). English and French only.
- Every rate is distance from Scribe, not accuracy (nobody checks the transcripts by hand): a model
  that fixes Scribe's mistakes scores worse for it.
- Speakers are scored by time: each Scribe word goes to the speaker turn holding its middle, labels
  paired one to one. Any model that returns timed speaker turns is scored the same way.
- Routing (`src/routing.ts`) is judged per speaker turn, in seconds: other-language speech left with
  the English and French model (missed) against English or French sent away (false alarms). A turn is
  routed when VoxLingua107 hears neither English nor French, or Parakeet Ultra wrote nothing there.
- Before adding models, sweep what was released lately (Hugging Face's API by date): the first runs
  were picked from memory and missed Parakeet Ultra, the eventual leader.
