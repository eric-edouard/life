"""Who spoke when in every clip, with pyannote's open pipeline on this Mac (needs HF_TOKEN, and
the model's terms accepted on Hugging Face once).

    uv run --project apps/transcription-bench/local python apps/transcription-bench/local/diarize.py <clips> <out>

Writes <out>/<clip>.json: speaker turns without overlap (the one speaker a word is credited to),
and the wall time. A clip already written is skipped.
"""

import json
import os
import sys
import time
from pathlib import Path

import soundfile
import torch
from pyannote.audio import Pipeline

clips, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-community-1", token=os.environ["HF_TOKEN"]
)
pipeline.to(torch.device("mps"))
for clip in sorted(clips.glob("*.wav")):
    target = out / f"{clip.stem}.json"
    if target.exists():
        continue
    began = time.perf_counter()
    # The waveform in memory: pyannote's own decoder needs FFmpeg's shared libraries.
    samples, rate = soundfile.read(clip, dtype="float32", always_2d=True)
    result = pipeline(
        {"sample_rate": rate, "waveform": torch.from_numpy(samples.T.copy())}
    )
    turns = [
        {"end": turn.end, "speaker": speaker, "start": turn.start}
        for turn, _, speaker in result.exclusive_speaker_diarization.itertracks(
            yield_label=True
        )
    ]
    target.write_text(
        json.dumps({"segments": turns, "wallSeconds": time.perf_counter() - began})
    )
    print(f"{clip.stem} {time.perf_counter() - began:.1f}s", flush=True)
