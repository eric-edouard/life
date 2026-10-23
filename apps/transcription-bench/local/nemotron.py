"""Who spoke when in every clip, with NVIDIA's Nemotron 3 Diarization through its native runtime,
NeMo-Speech.cpp (`nemo-speech`, its macOS Metal release; `NEMO_SPEECH` names the binary when it is
not on PATH). The model downloads on first use.

    uv run --project apps/transcription-bench/local python apps/transcription-bench/local/nemotron.py <clips> <out>

Writes <out>/<clip>.json like diarize.py: speaker turns and the wall time. A clip already written
is skipped. The offline preset suits the bench's two-minute clips.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

binary = os.environ.get("NEMO_SPEECH", "nemo-speech")
clips, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
for clip in sorted(clips.glob("*.wav")):
    target = out / f"{clip.stem}.json"
    if target.exists():
        continue
    began = time.perf_counter()
    answer = subprocess.run(
        [binary, "diarize", str(clip), "--preset", "v3-offline", "--format", "json"],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    segments = json.loads(answer.stdout)["segments"]
    target.write_text(
        json.dumps(
            {
                "segments": [
                    {"end": s["end"], "speaker": f"S{s['speaker']}", "start": s["start"]}
                    for s in segments
                ],
                "wallSeconds": time.perf_counter() - began,
            }
        )
    )
    print(f"{clip.stem} {time.perf_counter() - began:.1f}s", flush=True)
