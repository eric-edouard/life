"""Transcribes every clip in a folder with ElevenLabs Scribe, through its API (paid: run it on purpose).

    uv run --project apps/transcription-bench/local python apps/transcription-bench/local/scribe.py <model id> <clips> <out> [json]

The JSON holds the request's form fields (`language_code`, say) and may hold `groups`, as in run.py.
Writes <out>/<clip>.json like run.py: the text, the language Scribe names, its words as timed segments
with their speaker, and the wall time. Needs ELEVENLABS_API_KEY. A clip already written is skipped.
"""

import json
import os
import sys
import time
from pathlib import Path

import requests

model_id, clips, out = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
fields = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
groups = fields.pop("groups", None)
out.mkdir(parents=True, exist_ok=True)
for clip in sorted(clips.glob("*.wav")):
    target = out / f"{clip.stem}.json"
    if target.exists():
        continue
    if groups and json.loads(clip.with_suffix(".json").read_text())["group"] not in groups:
        continue
    began = time.perf_counter()
    with clip.open("rb") as audio:
        answer = requests.post(
            "https://api.elevenlabs.io/v1/speech-to-text",
            headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]},
            data={
                "model_id": model_id,
                "timestamps_granularity": "word",
                "diarize": "true",
                "tag_audio_events": "false",
                **fields,
            },
            files={"file": (clip.name, audio, "audio/wav")},
            timeout=600,
        )
    answer.raise_for_status()
    body = answer.json()
    words = [w for w in body.get("words", []) if w.get("type") == "word"]
    target.write_text(
        json.dumps(
            {
                "language": body.get("language_code"),
                "segments": [
                    {"end": w["end"], "speaker": w.get("speaker_id"), "start": w["start"], "text": w["text"]}
                    for w in words
                ],
                "text": body.get("text", ""),
                "wallSeconds": time.perf_counter() - began,
            },
            ensure_ascii=False,
        )
    )
    print(f"{clip.stem} {time.perf_counter() - began:.1f}s", flush=True)
