# Transcription bench: can open models replace Scribe?

October 2026. The code is `apps/transcription-bench`; its data (clips, every model's output, the per-clip reports) holds the
owner's voice and stays in the owner's private notes.

## Why

Scribe is paid per hour of audio, and a month of recordings can use up a plan's credits. It does everything Life
needs: English, French, the two mixed in one conversation, other languages (Thai, in the recordings measured here) and
speaker diarization. The question: can open models running on the Mac do all of that without paying for Scribe, and
if not, at what loss? English and French are most of the speech, so their quality comes first; the other languages
must not drag them down.

## How it was measured

- **Sample:** 70 two-minute windows drawn from the archive's completed jobs: 18 English, 18 French, 18 mixing both,
  8 Thai and 8 Thai with English, alternating one and several speakers.
- **Reference:** Scribe's stored transcript. Nobody corrected it (too long to do by hand), so every rate is a distance
  from Scribe, not an error rate: a model that fixes one of Scribe's mistakes scores worse for it.
- **Text distance:** word edit distance (Thai counted in characters), with fillers, hesitations and stutters removed.
- **Drift:** what matters for a memory, the words really different from Scribe's: a word that isn't small (de, the,
  à…) dropped, added or replaced by something that isn't a near-spelling.
- **Speakers:** words credited to another speaker than Scribe's, on clips with several.
- **Thai meaning:** on the 16 Thai clips, Codex translated every sentence of each version and judged whether its
  meaning matched Scribe's; listening showed Scribe is not reliable on Thai either.
- Everything ran on the Mac through MLX (mlx-audio 0.6.1), one model at a time.

## Results

Text distance from Scribe, and speed (times real time on an M-series Mac):

| model | en | fr | fr+en | th | th+en | speed |
|---|---|---|---|---|---|---|
| Parakeet Ultra (selcukkubur/parakeet-ultra-mlx) | 8.6% | 24.4% | 19.9% | – | – | 74× |
| Qwen3-ASR 1.7B | 8.8% | 38.4% | 20.4% | 22.7% | 102% | 8× |
| Cohere Transcribe (CohereLabs, 03-2026) | 11.6% | 28.7% | – | – | – | 38× |
| Canary 1B v2 | 14.7% | 33.1% | – | – | – | 20× |
| Parakeet TDT 0.6B v3 | 10.1% | 39.2% | 52.6% | – | – | 36× |
| Nemotron | 14.9% | 32.6% | 31.4% | – | – | 25× |
| Whisper large-v3 turbo | 18.5% | 33.4% | 51.7% | 68.3% | 84.5% | 12× |
| Kyutai STT 1B en/fr | 30.7% | 49.6% | 45.6% | – | – | 2× |
| Typhoon (Thai Whisper turbo) | – | – | – | 43.8% | 64.0% | 5× |
| Scribe told the audio is Thai (paid) | – | – | – | 7.1% | 12.4% | 7× |

A dash is a language the model doesn't do (its Thai output is over 85% off). Drift on English, French and mixed:
Parakeet Ultra 9.8% / 27.0% / 19.8%, the best of every open model; listening, it was sometimes right where Scribe was
wrong. Parked after partial runs (empty or looping output, or no Thai): Pathumma, VibeVoice ASR, Voxtral Mini and
Voxtral Realtime. Typhoon-Qwen 0.6B ran only after its weights were renamed (`local/convert_qwen3.py`) and was still
the worst on Thai.

## Who spoke

Words credited to another speaker than Scribe's, on the 40 clips with several speakers (each diarizer's speakers
paired one to one with Scribe's by the most words in common):

| diarizer | disagree | another speaker | heard no one | merged people (fewer than Scribe) | split one (more) | speed |
|---|---|---|---|---|---|---|
| **Nemotron 3 Diarization** (NVIDIA, Sep 2026) | **8.5%** | 6.0% | 2.5% | 8 clips | 2 clips | 158× |
| pyannote community-1 | 15.7% | 11.1% | 4.6% | 16 clips | 6 clips | 16× |

`bench score` prints the disagreement; the breakdown and the people counts come from a one-off comparison of the
same outputs, word by word. Scribe told the audio is Thai disagrees with Scribe on its own default at 13.7%, so part of any gap is Scribe's own
variance. Merging two people is the costly mistake for Life: recognition pools a speaker's turns into one voice
(`people.ts` `match`), so a merged voice matches nobody or credits one person with the other's turns. Splitting one
person is cheap, since both halves match the same profile. Nemotron 3 runs through NVIDIA's native runtime,
NeMo-Speech.cpp (`local/nemotron.py`; macOS Metal, Linux CPU, CUDA and Vulkan builds; a 102 MB GGUF), at about half a
second per two-minute clip once loaded (the table's speed counts loading it for every clip).

Scribe merges people too: about 2% of its speakers hold two voices (Life issue #59, from 25 speakers the owner
rated by ear).

## Finding the Thai

No open model does English, French and Thai well, so the Thai has to be found and sent elsewhere. Each speaker turn
of a second or more is judged; seconds of Thai missed and seconds of English or French sent away, on each
diarizer's turns (`bench route [diarizer]`):

| detector | missed, pyannote's turns | false alarms | missed, Nemotron 3's turns | false alarms |
|---|---|---|---|---|
| VoxLingua107: neither English nor French | 7.6% | 12.7% | 4.0% | 15.1% |
| Parakeet Ultra wrote nothing | 35.4% | 1.0% | 35.7% | 0.5% |
| Codex reading Ultra's text | 56.0% | 9.3% | – | – |
| **VoxLingua107 neither, or Ultra wrote nothing** | 3.1% | 13.1% | **1.6%** | **15.4%** |

pyannote gave 720 turns (205 Thai by Scribe's words), Nemotron 3 845 (228 Thai). On Nemotron 3's turns the rule misses
half as much Thai, for about two more points of English and French sent to Scribe. The Codex reader was dropped: it
missed most of the Thai, and a model call belongs to the Mac helper.

VoxLingua107 (SpeechBrain, 2021) is still the standard open language identifier; nothing general and better came out
by October 2026. Qwen3-ASR's own detection is the one untested contender. A false alarm costs only money (it goes to
the stronger model); a miss loses Thai.

## The pipeline

Diarize (scored here with pyannote's turns), label each turn with the rule above, transcribe English and French with Parakeet Ultra and the
routed turns with the Thai model; a block that is 70% routed goes whole to the Thai model. Distance from Scribe:

| pipeline, Thai model | en | fr | fr+en | th | th+en | Thai sentences whose meaning was lost |
|---|---|---|---|---|---|---|
| Qwen3-ASR | 9.4% | 25.3% | 20.8% | 26.2% | 29.2% | 294 s of 958 |
| Typhoon | 34.5% | 62.9% | 58.8% | 42.3% | 44.0% | 457 s |
| Scribe told Thai (paid) | | | | 10.8% | 15.6% | 123 s |

Scribe told Thai on whole clips, for comparison: 7.1% / 12.4%, 98 s lost. The Scribe pipeline ran on the Thai clips only.

English and French through the Qwen3 pipeline stay near Parakeet Ultra's level; Typhoon's rows are worse because
it turns the false alarms' English and French into Thai.

## On a Linux server, CPU only

Can the pipeline leave the Mac for a rented server with no GPU? Measured on 23 October on a Hetzner CPX42 (8 shared
vCPU, AMD EPYC Genoa, 16 GB, Ubuntu 24.04), rented by the hour and deleted after; the CX43 asked for was sold out
everywhere, and the CPX42's cores are newer, so its speeds are a little optimistic for a CX. A one-off proof of
concept: its scripts sit with the bench's data in the owner's private notes (`cpu/`), and its outputs were scored by
`bench score` like any model.

**Parakeet Ultra as ONNX: full precision only.** Moondream's weights exported for onnx-asr
(Masterx/parakeet-tdt-0.6b-ultra-onnx), on onnxruntime's CPU provider:

| Parakeet Ultra | en | fr | fr+en | drift en / fr / fr+en | speed, 8 threads |
|---|---|---|---|---|---|
| MLX on the Mac | 8.6% | 24.4% | 19.9% | 9.8% / 27.0% / 19.8% | 74× |
| ONNX fp32 on the box | 8.6% | 24.5% | 20.2% | 9.6% / 26.7% / 20.9% | 17× |

Same checkpoint, same distance from Scribe. Every int8 build drops speech: up to 87% of a clip's words, on two
different exports of Ultra (sherpa-onnx and onnx-asr) and on NVIDIA's own Parakeet v3 int8 alike, whole clips or
10-second pieces; fp32 of the same exports doesn't. fp16 runs no faster and takes more memory (onnxruntime widens it
to fp32 on CPU), so fp32 it is.

**Nemotron 3 on CPU** (through Transformers, offline; its overlapping turns cut where the next one starts): 8.9% of
words credited to another speaker than Scribe's, against 8.5% through NeMo-Speech.cpp on the Mac, at 60× real time.

**A two-minute block, end to end** (speaker turns, VoxLingua107 on each turn, Parakeet on the
block; every model loaded in one process; five blocks of 2 to 2.4 minutes, English, French, mixed and Thai):

| threads (plan) | Nemotron 3 | VoxLingua107 | Parakeet Ultra | total |
|---|---|---|---|---|
| 8 (CX43, CPX42) | 2 s | 1–2 s | 7–9 s | 10–13 s |
| 4 (CX33) | 3.5–4.5 s | 1.5–3 s | 10–13 s | 15–20 s |
| 2 (CX23) | 5–7 s | 2–4 s | 17–22 s | 24–33 s |

Peak memory with every model loaded: 5.1 GB (Parakeet Ultra fp32 alone 3.9 GB). Scribe's turns come on top: it ran
at 7× real time in the bench, so a block with Thai waits a few more seconds.

**Fixing Nemotron's speakers: inconclusive.** Three corrections were tried on its turns: moving boundaries to
Parakeet's nearest word gap, splitting a turn where its voice drifts (ECAPA windows) and re-clustering the pieces,
and scoring the owner's enrolled voice first. None scored better than Nemotron as is (8.9%), but the method was
flawed: the drift pieces and the owner's turns got new labels that the one-to-one pairing counts as wrong by
construction, and the ONNX tokens carry no end times, so the "gaps" were word onsets. Not worth more until a method
keeps each person under one label.

So on a server: 8 GB of memory at least (the models and Life), 4 vCPU for a transcript about 20 seconds after a block
closes, 2 vCPU still well inside the minutes allowed. Not measured: pyannote and `diarize` on CPU (pyannote is
replaced), and NeMo-Speech.cpp's own CPU speed.

## Conclusion

- **English and French: Parakeet Ultra, locally, at no loss.** It is as close to Scribe as anything measured, beats it
  at times, and runs at 74× real time.
- **Thai: no open model is good enough.** The best pipeline (Qwen3-ASR) loses the meaning of about a third of the
  Thai.
- **Who spoke: Nemotron 3 Diarization, locally.** Half pyannote's disagreement with Scribe, half its merges, and
  better turns for routing.
- **Recommended:** Nemotron 3 for speaker turns, VoxLingua107 plus "Ultra wrote nothing" to route each turn, Parakeet
  Ultra for English and French, and Scribe only for the routed turns, with its language left on auto so any other
  language works too. Scribe then hears about 15 to 25% of the audio instead of all of it, and its Thai holds (123 s
  of meaning lost against 98 s for Scribe on whole clips).
- **The cost of going local:** diarization stays the weakest part (8.5% off Scribe), and on the Mac the models share
  its GPU with the server (in Voice Host).
- **On a server without a GPU it holds:** Parakeet Ultra as ONNX fp32 (never int8) is as close to Scribe as on the
  Mac, and a two-minute block is done in 10 to 33 seconds on 8 to 2 vCPU, in 5.1 GB.

## Open questions

- Scribe on single turns: the pipeline above took Scribe's words from whole clips inside the routed turns. Sent one
  short turn at a time, Scribe loses its context and may do worse.
- Other languages: only Thai was tested. Parakeet covers about 25 European languages, so it writes Spanish or German
  plausibly and only VoxLingua would route them.
- Qwen3-ASR's language detection, per turn, against VoxLingua.
- The pipeline's text was scored on pyannote's turns; on Nemotron 3's, routing improves, so its Thai should too.
