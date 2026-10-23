"""Transcribes every clip in a folder with one open model on this Mac (MLX), loaded once.

    uv run --project apps/transcription-bench/local python apps/transcription-bench/local/run.py <hf-model> <clips> <out> [json]

The optional JSON holds arguments for the model's `generate` (Voxtral's language, say), plus
`groups`: only the clips of those groups (its <clip>.json `group`), for a model that covers some
languages only. Any value "given" is the clip's group (en, fr), for a model that cannot detect.
`processor` names the original repo of a Whisper build that ships without its tokenizer files.
`turns` names a JSON file of {clip: [[start, end], …]}: only those stretches of those clips are
transcribed, each capped at 40 + 25 tokens a second (a guard against looping), and the clip's
<clip>.json holds them as `segments`.
`load` holds arguments for loading it (`model_type` where its folder's name does not say).
`chunk` (seconds) feeds a model that stops early on long audio its clip in pieces of that length,
cut at fixed points, and joins the texts.
With STT_BENCH_MODELS set, a model already copied to <that folder>/<hf-model> is read from there
(fetched by hand where Hugging Face's own downloads keep stalling).

Writes <out>/<clip>.json: the text, the language the model reports, its timed segments (with a
speaker when the model gives one) and the wall time.
A clip already written is skipped, so a run picks up where it stopped.
"""

import json
import math
import os
import sys
import time
from pathlib import Path

from mlx_audio.stt.utils import load_model

model_id, clips, out = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
kwargs = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
groups = kwargs.pop("groups", None)
processor = kwargs.pop("processor", None)
chunk = kwargs.pop("chunk", None)
load = kwargs.pop("load", {})
turns = json.loads(Path(kwargs.pop("turns")).read_text()) if "turns" in kwargs else None
out.mkdir(parents=True, exist_ok=True)


def finite(value):
    """NaN and infinities as null: JSON has no word for them (Whisper's scores can be NaN)."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [finite(v) for v in value]
    return value


local = Path(os.environ.get("STT_BENCH_MODELS", "/nonexistent")) / model_id
model = load_model(str(local) if local.is_dir() else model_id, **load)
if processor:
    from transformers import WhisperProcessor

    # mlx-audio's Whisper reads its tokenizer from here (whisper.py `post_load_hook`).
    model._processor = WhisperProcessor.from_pretrained(processor)
for clip in sorted(clips.glob("*.wav")):
    target = out / f"{clip.stem}.json"
    if target.exists():
        continue
    group = json.loads(clip.with_suffix(".json").read_text())["group"]
    if groups and group not in groups:
        continue
    args = {k: group if v == "given" else v for k, v in kwargs.items()}
    if turns is not None and clip.stem not in turns:
        continue
    began = time.perf_counter()
    if turns is not None:
        import mlx.core as mx
        import soundfile

        samples, rate = soundfile.read(clip, dtype="float32")
        heard = [
            {
                "end": end,
                "start": start,
                "text": model.generate(
                    mx.array(samples[int(start * rate) : int(end * rate)]),
                    **{**args, "max_tokens": int(40 + 25 * (end - start))},
                ).text.strip(),
            }
            for start, end in turns[clip.stem]
        ]
        result = type("Turns", (), {"segments": heard, "text": " ".join(h["text"] for h in heard)})()
    elif chunk:
        import mlx.core as mx
        import soundfile

        samples, rate = soundfile.read(clip, dtype="float32")
        step = int(chunk * rate)
        parts = [
            model.generate(mx.array(samples[i : i + step]), **args)
            for i in range(0, len(samples), step)
        ]
        result = type("Joined", (), {"text": " ".join(p.text.strip() for p in parts)})()
    else:
        result = model.generate(str(clip), **args)
    record = json.loads(
        json.dumps(
            {
                "language": getattr(result, "language", None),
                "segments": getattr(result, "segments", None)
                or getattr(result, "sentences", None),
                "text": result.text,
                "wallSeconds": time.perf_counter() - began,
            },
            default=lambda o: getattr(o, "__dict__", str(o)),
        )
    )
    target.write_text(json.dumps(finite(record), ensure_ascii=False, allow_nan=False))
    print(f"{clip.stem} {time.perf_counter() - began:.1f}s", flush=True)
